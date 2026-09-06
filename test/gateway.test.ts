import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class DiscordSocket extends EventTarget {
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly connections: DiscordSocket[] = [];
  readonly sent: string[] = [];
  readyState = 1;
  constructor(readonly url: string) {
    super();
    DiscordSocket.connections.push(this);
  }
  send(value: string): void {
    this.sent.push(value);
  }
  close(): void {
    this.readyState = 3;
  }
  packet(value: {
    op: number;
    d?: boolean | { heartbeat_interval?: number; session_id?: string; resume_gateway_url?: string };
    t?: string;
    s?: number;
  }): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
  remoteClose(code: number): void {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code }));
  }
}

describe("single Gateway connection lifecycle", () => {
  beforeEach(() => {
    DiscordSocket.connections.length = 0;
    vi.stubGlobal("WebSocket", DiscordSocket);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        url: "wss://gateway.discord.gg",
        shards: 1,
        session_start_limit: { remaining: 1000, reset_after: 86_400_000 },
      })
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("identifies once, checks heartbeat ACKs, and resumes without another identify", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const stub = env.BOT_CONTROL.get(env.BOT_CONTROL.idFromName("gateway-resume-test"));
    await stub.fetch("https://bot/ensure");
    await stub.fetch("https://bot/ensure");
    expect(DiscordSocket.connections).toHaveLength(1);
    const first = DiscordSocket.connections[0];
    await runInDurableObject(stub, async () => {
      first.packet({ op: 10, d: { heartbeat_interval: 40_000 } });
    });
    expect(first.sent[0]).toContain('"op":2');
    expect(first.sent[0]).toContain('"intents":0');
    await runInDurableObject(stub, async () => {
      first.packet({
        op: 0,
        t: "READY",
        s: 7,
        d: { session_id: "session-1", resume_gateway_url: "wss://gateway-us-east1-b.discord.gg" },
      });
    });
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.sync();
    });
    expect(await (await stub.fetch("https://bot/status")).text()).toContain('"gateway":"ready"');
    await runInDurableObject(stub, async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(first.sent.at(-1)).toBe('{"op":1,"d":7}');
    await runInDurableObject(stub, async () => {
      first.packet({ op: 11 });
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(first.readyState).toBe(1);
    await runInDurableObject(stub, async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(first.readyState).toBe(3);
    await stub.fetch("https://bot/ensure");
    expect(DiscordSocket.connections).toHaveLength(2);
    const second = DiscordSocket.connections[1];
    expect(second.url).toContain("gateway-us-east1-b.discord.gg");
    await runInDurableObject(stub, async () => {
      second.packet({ op: 10, d: { heartbeat_interval: 40_000 } });
    });
    expect(second.sent[0]).toContain('"op":6');
    expect(second.sent[0]).toContain('"session_id":"session-1"');
    expect(second.sent[0]).toContain('"seq":7');
    await runInDurableObject(stub, async () => {
      second.remoteClose(4004);
    });
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.sync();
    });
  });

  it("stops reconnecting on fatal Discord close codes", async () => {
    const stub = env.BOT_CONTROL.get(env.BOT_CONTROL.idFromName("gateway-fatal-test"));
    await stub.fetch("https://bot/ensure");
    await runInDurableObject(stub, async () => {
      DiscordSocket.connections[0].remoteClose(4014);
    });
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.sync();
    });
    await stub.fetch("https://bot/ensure");
    expect(DiscordSocket.connections).toHaveLength(1);
    expect(await (await stub.fetch("https://bot/status")).text()).toContain("discord-close-4014");
  });

  it("backs off discovery failures instead of reconnecting on every request", async () => {
    const fetcher = vi
      .mocked(globalThis.fetch)
      .mockImplementation(async () => new Response(null, { status: 503 }));
    const stub = env.BOT_CONTROL.get(env.BOT_CONTROL.idFromName("gateway-backoff-test"));
    await stub.fetch("https://bot/ensure");
    await stub.fetch("https://bot/ensure");
    await stub.fetch("https://bot/ensure");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(DiscordSocket.connections).toHaveLength(0);
  });

  it("respects Discord's remaining session budget", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async () =>
      Response.json({
        url: "wss://gateway.discord.gg",
        shards: 1,
        session_start_limit: { remaining: 0, reset_after: 86_400_000 },
      })
    );
    const stub = env.BOT_CONTROL.get(env.BOT_CONTROL.idFromName("gateway-budget-test"));
    await stub.fetch("https://bot/ensure");
    expect(DiscordSocket.connections).toHaveLength(0);
    await runInDurableObject(stub, async (_instance, state) => {
      const connection = await state.storage.get<{ nextAttemptAt: number }>("connection");
      expect(connection?.nextAttemptAt).toBeGreaterThan(Date.now() + 23 * 60 * 60_000);
    });
  });
});
