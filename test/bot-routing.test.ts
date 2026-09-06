import { env } from "cloudflare:workers";
import { applyD1Migrations, runInDurableObject, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import type { DiscordInteraction } from "../src/discord/protocol";
import { forwardToDev, tunnelUrl } from "../src/discord/dev-route";

const guildId = "1115740106918203453";
const testEnv: Env = {
  ...env,
  APP_ENV: "production",
  TEST_GUILD_ID: guildId,
  BOT_ADMIN_TOKEN: "test-admin-token",
};
let privateKey: CryptoKey;

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signed(interaction: DiscordInteraction): Promise<Request> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify(interaction);
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    new TextEncoder().encode(timestamp + body)
  );
  return new Request("https://bot.test/", {
    method: "POST",
    body,
    headers: { "X-Signature-Timestamp": timestamp, "X-Signature-Ed25519": hex(signature) },
  });
}

function balance(guild = guildId): DiscordInteraction {
  return {
    id: "routing-balance",
    token: "test-token",
    type: 2,
    guild_id: guild,
    member: { user: { id: "routing-user" } },
    data: { name: "balance" },
  };
}

function control(method: string, payload?: { url: string; lease: string }): Promise<Response> {
  return worker.fetch(
    new Request("https://bot.test/admin/dev", {
      method,
      headers: { Authorization: "Bearer test-admin-token" },
      body: payload ? JSON.stringify(payload) : undefined,
    }),
    testEnv
  );
}

describe("production / local dev isolation", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ environment: "local", guildId })
    );
  });
  beforeAll(async () => {
    // SAFETY: the test plugin injects TEST_MIGRATIONS in vitest.config.ts.
    await applyD1Migrations(
      env.DB,
      (env as typeof env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS
    );
    // SAFETY: Ed25519 generateKey returns a key pair, not a symmetric key.
    const pair = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    privateKey = pair.privateKey;
    testEnv.DISCORD_PUBLIC_KEY = hex(await crypto.subtle.exportKey("raw", pair.publicKey));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    const stub = env.BOT_CONTROL.get(env.BOT_CONTROL.idFromName("singleton"));
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.delete("dev-route");
    });
  });

  it("rejects unauthenticated switching", async () => {
    const response = await worker.fetch(
      new Request("https://bot.test/admin/dev", { method: "DELETE" }),
      testEnv
    );
    expect(response.status).toBe(401);
  });

  it("refuses a tunnel serving the wrong environment", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async () =>
      Response.json({ environment: "production", guildId })
    );
    expect(
      (
        await control("PUT", {
          url: "https://chip-test.trycloudflare.com",
          lease: "wrong-environment-lease",
        })
      ).status
    ).toBe(503);
    expect(await (await worker.fetch(await signed(balance()), testEnv)).text()).toContain(
      "Production data was not accessed"
    );
  });

  it("keeps test commands out of production when dev is disconnected", async () => {
    const response = await worker.fetch(await signed(balance()), testEnv);
    expect(await response.text()).toContain("Production data was not accessed");
    const account = await env.DB.prepare(
      "SELECT * FROM user_guild_stats WHERE user_id = ? AND guild_id = ?"
    )
      .bind("routing-user", guildId)
      .first();
    expect(account).toBeNull();
  });

  it("continues serving production in other servers", async () => {
    const response = await worker.fetch(await signed(balance("other-server")), testEnv);
    expect(await response.text()).toContain("100 chips");
  });

  it("routes an active test session without creating a production account", async () => {
    await control("PUT", {
      url: "https://chip-test.trycloudflare.com",
      lease: "active-routing-lease",
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ type: 4, data: { content: "[DEV] local balance" } })
    );
    const interaction = { ...balance(), member: { user: { id: "dev-only-user" } } };
    expect(await (await worker.fetch(await signed(interaction), testEnv)).text()).toContain(
      "[DEV] local balance"
    );
    const account = await env.DB.prepare(
      "SELECT * FROM user_guild_stats WHERE user_id = ? AND guild_id = ?"
    )
      .bind("dev-only-user", guildId)
      .first();
    expect(account).toBeNull();
  });

  it("does not expose the admin controls through the local tunnel", async () => {
    const localEnv: Env = { ...testEnv, APP_ENV: "local" };
    const response = await worker.fetch(
      new Request("https://local/admin/dev", {
        method: "DELETE",
        headers: { Authorization: "Bearer test-admin-token" },
      }),
      localEnv
    );
    expect(response.status).toBe(404);
  });

  it("requires an explicit production switch and prevents an old dev renewal from undoing it", async () => {
    const lease = { url: "https://chip-test.trycloudflare.com", lease: "a-valid-test-lease" };
    expect((await control("PUT", lease)).status).toBe(200);
    expect((await control("DELETE")).status).toBe(200);
    expect((await control("PATCH", lease)).status).toBe(409);
    expect(await (await worker.fetch(await signed(balance()), testEnv)).text()).toContain(
      "100 chips"
    );
  });

  it("rejects competing local sessions", async () => {
    expect(
      (
        await control("PUT", {
          url: "https://chip-test.trycloudflare.com",
          lease: "first-test-lease-123",
        })
      ).status
    ).toBe(200);
    expect(
      (
        await control("PUT", {
          url: "https://chip-test.trycloudflare.com",
          lease: "second-test-lease-123",
        })
      ).status
    ).toBe(409);
  });

  it("does not send expired leases to a reused tunnel hostname", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const response = await forwardToDev(
      new Request("https://bot/", { method: "POST", body: "{}" }),
      {
        mode: "development",
        url: "https://chip-test.trycloudflare.com",
        lease: "expired-lease",
        expiresAt: Date.now() - 1,
      }
    );
    expect(await response.text()).toContain("Production data was not accessed");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed on tunnel errors and never interprets a dev HTTP 204 as production routing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const response = await forwardToDev(
      new Request("https://bot/", { method: "POST", body: "{}" }),
      {
        mode: "development",
        url: "https://chip-test.trycloudflare.com",
        lease: "active-lease",
        expiresAt: Date.now() + 60_000,
      }
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Production data was not accessed");
  });

  it("preserves Discord's signed body and headers when forwarding", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ type: 4, data: { content: "[DEV] result" } }));
    const request = await signed(balance());
    const signature = request.headers.get("X-Signature-Ed25519");
    const result = await forwardToDev(request, {
      mode: "development",
      url: "https://chip-test.trycloudflare.com",
      lease: "active-lease",
      expiresAt: Date.now() + 60_000,
    });
    expect(await result.text()).toContain("[DEV] result");
    expect(fetcher).toHaveBeenCalledWith(
      "https://chip-test.trycloudflare.com",
      expect.objectContaining({
        body: JSON.stringify(balance()),
        redirect: "manual",
        headers: expect.objectContaining({ "X-Signature-Ed25519": signature }),
      })
    );
  });

  it("rejects old dev buttons after switching to production", async () => {
    await control("DELETE");
    const interaction = { ...balance(), type: 3, data: { custom_id: "dev:game:missing:join" } };
    const response = await worker.fetch(await signed(interaction), testEnv);
    expect(await response.text()).toContain("different environment");
  });

  it("rejects production buttons and other guilds in local dev", async () => {
    const localEnv: Env = { ...testEnv, APP_ENV: "local" };
    const interaction = { ...balance(), type: 3, data: { custom_id: "prod:game:missing:join" } };
    expect(await (await worker.fetch(await signed(interaction), localEnv)).text()).toContain(
      "different environment"
    );
    expect(
      await (await worker.fetch(await signed(balance("other-server")), localEnv)).text()
    ).toContain("only the configured test server");
  });

  it("only accepts quick tunnel origins", () => {
    for (const url of [
      "http://localhost",
      "https://example.com",
      "https://x.trycloudflare.com.evil.test",
      "https://x.trycloudflare.com/path",
      "https://user@x.trycloudflare.com",
    ])
      expect(() => tunnelUrl(url)).toThrow();
  });
});
