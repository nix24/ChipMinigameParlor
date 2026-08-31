import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { handleCommand } from "../src/commands";
import type { DiscordInteraction } from "../src/discord/protocol";

describe("interaction worker", () => {
  beforeAll(async () => {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY NOT NULL,
        created_at INTEGER NOT NULL
      )
    `).run();
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS guilds (
        id TEXT PRIMARY KEY NOT NULL,
        created_at INTEGER NOT NULL
      )
    `).run();
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS user_guild_stats (
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        chips INTEGER NOT NULL DEFAULT 100,
        games_played INTEGER NOT NULL DEFAULT 0,
        last_daily_claimed_at INTEGER,
        PRIMARY KEY (user_id, guild_id)
      )
    `).run();
  });

  it("does not expose a GET route", async () => {
    const worker = (await import("../src/index")).default;
    const response = await worker.fetch(new Request("https://example.test"), env);
    expect(response.status).toBe(404);
  });

  it("keeps Big Blast lobby membership in one Durable Object", async () => {
    const gameId = "bigblast-test";
    const stub = env.GAME_SESSIONS.get(env.GAME_SESSIONS.idFromName(gameId));
    const init = await stub.fetch("https://game/init", {
      method: "POST",
      body: JSON.stringify({
        action: "init",
        gameId,
        game: "bigblast",
        guildId: "guild",
        hostId: "host",
      }),
    });
    expect(await init.text()).toContain("1/4");

    const interaction = {
      id: "component-1",
      token: "token",
      type: 3,
      guild_id: "guild",
      member: { user: { id: "player" } },
      data: { custom_id: `game:${gameId}:join` },
    } satisfies DiscordInteraction;
    const joined = await stub.fetch("https://game/component", {
      method: "POST",
      body: JSON.stringify({ action: "component", interaction }),
    });
    expect(await joined.text()).toContain("2/4");

    const duplicate = await stub.fetch("https://game/component", {
      method: "POST",
      body: JSON.stringify({ action: "component", interaction }),
    });
    expect(await duplicate.text()).toContain("2/4");
  });

  it("settles a Coin Flip wager", async () => {
    const response = await handleCommand(env, {
      id: "coinflip-test",
      token: "token",
      type: 2,
      guild_id: "coinflip-guild",
      member: { user: { id: "coinflip-player" } },
      data: {
        name: "coinflip",
        options: [
          { name: "amount", value: 5 },
          { name: "choice", value: "heads" },
        ],
      },
    } satisfies DiscordInteraction);

    expect(response.type).toBe(4);
    expect(response.data?.content).toMatch(/coin landed on \*\*(Heads|Tails)\*\*/);
    expect(response.data?.content).toMatch(/New balance: \*\*(95|105)\*\*/);
  });
});
