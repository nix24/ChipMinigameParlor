import { env } from "cloudflare:workers";
import { applyD1Migrations, runInDurableObject, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { coinflipApi } from "../src/games/coinflip-api";
import { EconomyRepository } from "../src/db/repository";
import type { Env } from "../src/env";

// SAFETY: Vitest supplies TEST_MIGRATIONS through its configured binding.
const testEnv = env as typeof env & { TEST_MIGRATIONS: D1Migration[] };
const guildId = "11111111111111111";
const userId = "22222222222222222";
const clientId = "33333333333333333";
const activityEnv: Env = {
  ...env,
  APP_ENV: "staging",
  DISCORD_CLIENT_ID: clientId,
  DISCORD_CLIENT_SECRET: "test-only-oauth-secret",
};
const round = { roundId: "b68357ea-21d1-41d4-a4cc-2c10ab5f4544", amount: 10, choice: "heads" };

function request(path: string, body: string, session = ""): Request {
  return new Request(`https://example.test/api/activity/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session}` },
    body,
  });
}

function mockDiscord(memberStatus = 200): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "https://discord.com/api/v10/oauth2/token") {
      expect(init?.method).toBe("POST");
      return Response.json({ access_token: "test-only-access-token", expires_in: 3600 });
    }
    expect(url).toBe(`https://discord.com/api/v10/users/@me/guilds/${guildId}/member`);
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-only-access-token");
    return Response.json({ user: { id: userId }, pending: false }, { status: memberStatus });
  });
}

async function session(): Promise<string> {
  mockDiscord();
  const response = await coinflipApi(
    request("session", JSON.stringify({ code: "test-code", guildId })),
    activityEnv
  );
  expect(response.status).toBe(200);
  const result = await response.json<{ session: string; chips: number; userId: string }>();
  expect(result.userId).toBe(userId);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return result.session;
}

describe("Coinflip Activity", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, testEnv.TEST_MIGRATIONS);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("settles concurrent retries once, using the authenticated identity", async () => {
    const token = await session();
    const before = await new EconomyRepository(activityEnv).balance(userId, guildId);
    const results = await Promise.all(
      [1, 2].map(() => coinflipApi(request("flip", JSON.stringify(round), token), activityEnv))
    );
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    const [first, duplicate] = await Promise.all(
      results.map((result) =>
        result.json<{ settled: boolean; chips: number; outcome: string; won: boolean }>()
      )
    );
    expect(first).toEqual(duplicate);
    expect(first.settled).toBe(true);
    expect(["heads", "tails"]).toContain(first.outcome);
    expect(first.won).toBe(first.outcome === "heads");
    expect(first.chips).toBe(before + (first.won ? 10 : -10));
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM chip_transactions WHERE id = ?"
    )
      .bind(`activity:coinflip:${guildId}:${userId}:${round.roundId}`)
      .first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("replays the stored landing for either side, regardless of fresh randomness", async () => {
    const token = await session();
    for (const outcome of ["heads", "tails"] as const) {
      const roundId = crypto.randomUUID();
      await new EconomyRepository(activityEnv).settleWager({
        transactionId: `activity:coinflip:${guildId}:${userId}:${roundId}`,
        userId,
        guildId,
        game: "coinflip",
        requestFingerprint: `coinflip:${userId}:${guildId}:5:tails`,
        stake: 5,
        payout: outcome === "tails" ? 10 : 0,
        result: outcome,
      });
      const response = await coinflipApi(
        request("flip", JSON.stringify({ roundId, amount: 5, choice: "tails" }), token),
        activityEnv
      );
      expect(await response.json()).toMatchObject({
        settled: true,
        outcome,
        won: outcome === "tails",
      });
    }
  });

  it("uses one D1 batch for a normal round on an existing account", async () => {
    const token = await session();
    const batch = vi.spyOn(activityEnv.DB, "batch");
    const response = await coinflipApi(
      request("flip", JSON.stringify({ ...round, roundId: crypto.randomUUID() }), token),
      activityEnv
    );
    expect(response.status).toBe(200);
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("never falls through to production chips while the test server is in development", async () => {
    const production: Env = { ...activityEnv, APP_ENV: "production", TEST_GUILD_ID: guildId };
    const stub = env.BOT_CONTROL.get(env.BOT_CONTROL.idFromName("singleton"));
    const login = () =>
      coinflipApi(request("session", JSON.stringify({ code: "test-code", guildId })), production);
    expect((await login()).status).toBe(403);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("dev-route", { mode: "production" });
    });
    mockDiscord();
    const connected = await login();
    expect(connected.status).toBe(200);
    const { session: token } = await connected.json<{ session: string }>();
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("dev-route", { mode: "development" });
    });
    const batch = vi.spyOn(activityEnv.DB, "batch");
    expect(
      (await coinflipApi(request("flip", JSON.stringify(round), token), production)).status
    ).toBe(403);
    expect(batch).not.toHaveBeenCalled();
  });

  it("rejects missing, tampered, expired, and cross-environment credentials", async () => {
    const token = await session();
    expect((await coinflipApi(request("flip", JSON.stringify(round)), activityEnv)).status).toBe(
      401
    );
    const [payload, signature] = token.split(".");
    expect(
      (
        await coinflipApi(
          request("flip", JSON.stringify(round), `${payload}.AAAA${signature.slice(4)}`),
          activityEnv
        )
      ).status
    ).toBe(401);
    expect(
      (
        await coinflipApi(request("flip", JSON.stringify(round), token), {
          ...activityEnv,
          APP_ENV: "production",
        })
      ).status
    ).toBe(401);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60_000);
    expect(
      (await coinflipApi(request("flip", JSON.stringify(round), token), activityEnv)).status
    ).toBe(401);
  });

  it("requires Discord membership and protects the local guild boundary", async () => {
    mockDiscord(403);
    expect(
      (
        await coinflipApi(
          request("session", JSON.stringify({ code: "test-code", guildId })),
          activityEnv
        )
      ).status
    ).toBe(403);
    expect(
      (
        await coinflipApi(request("session", JSON.stringify({ code: "test-code", guildId })), {
          ...activityEnv,
          APP_ENV: "local",
          TEST_GUILD_ID: "44444444444444444",
        })
      ).status
    ).toBe(403);
  });

  it("rejects malformed wagers and client identity or payout overrides before touching D1", async () => {
    const token = await session();
    const before = await new EconomyRepository(activityEnv).balance(userId, guildId);
    for (const invalid of [
      { ...round, amount: 0 },
      { ...round, amount: 1.5 },
      { ...round, amount: Number.MAX_SAFE_INTEGER },
      { ...round, choice: "edge" },
      { ...round, roundId: "bad-id" },
      { ...round, userId: "someone-else" },
      { ...round, payout: 1000 },
      { ...round, guildId: "someone-else" },
    ])
      expect(
        (await coinflipApi(request("flip", JSON.stringify(invalid), token), activityEnv)).status
      ).toBe(400);
    expect((await coinflipApi(request("flip", "x".repeat(2049), token), activityEnv)).status).toBe(
      413
    );
    expect(await new EconomyRepository(activityEnv).balance(userId, guildId)).toBe(before);
  });

  it("rejects unaffordable wagers without creating a ledger row", async () => {
    const token = await session();
    const roundId = crypto.randomUUID();
    const response = await coinflipApi(
      request("flip", JSON.stringify({ ...round, roundId, amount: 10000 }), token),
      activityEnv
    );
    expect(await response.json()).toMatchObject({ settled: false, reason: "insufficient-funds" });
    const row = await env.DB.prepare("SELECT id FROM chip_transactions WHERE id = ?")
      .bind(`activity:coinflip:${guildId}:${userId}:${roundId}`)
      .first();
    expect(row).toBeNull();
  });

  it("does not expose secrets in public configuration", async () => {
    const response = await coinflipApi(
      new Request("https://example.test/api/activity/config"),
      activityEnv
    );
    expect(await response.json()).toEqual({
      clientId,
      maxStake: Math.floor(Number.MAX_SAFE_INTEGER / 2),
      environment: "staging",
    });
  });
});
