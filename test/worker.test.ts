import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { handleCommand } from "../src/commands";
import { EconomyRepository } from "../src/db/repository";
import { RunRepository } from "../src/db/run-repository";
import type { DiscordInteraction } from "../src/discord/protocol";

// SAFETY: Vitest supplies TEST_MIGRATIONS from the binding configured in vitest.config.ts.
const testEnv = env as typeof env & { TEST_MIGRATIONS: D1Migration[] };

function command(
  id: string,
  name: string,
  userId: string,
  guildId: string,
  options?: NonNullable<DiscordInteraction["data"]>["options"]
): DiscordInteraction {
  return {
    id,
    token: "token",
    type: 2,
    guild_id: guildId,
    member: { user: { id: userId } },
    data: { name, options },
  };
}

function coinFlip(id: string, userId: string, guildId: string, amount = 5): DiscordInteraction {
  return command(id, "coinflip", userId, guildId, [
    { name: "amount", value: amount },
    { name: "choice", value: "heads" },
  ]);
}

async function stats(userId: string, guildId: string): Promise<{ chips: number; games: number }> {
  const row = await env.DB.prepare(
    "SELECT chips, games_played AS games FROM user_guild_stats WHERE user_id = ? AND guild_id = ?"
  )
    .bind(userId, guildId)
    .first<{ chips: number; games: number }>();
  if (!row) throw new Error("Expected player stats.");
  return row;
}

async function transactionCount(id: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM chip_transactions WHERE id = ?")
    .bind(id)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

describe("interaction worker", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, testEnv.TEST_MIGRATIONS);
  });

  it("does not expose unknown GET routes", async () => {
    const worker = (await import("../src/index")).default;
    const response = await worker.fetch(new Request("https://example.test/not-a-route"), env);
    expect(response.status).toBe(404);
  });

  it("serves the built Activity and its entry script", async () => {
    const worker = (await import("../src/index")).default;
    const page = await worker.fetch(new Request("https://example.test/"), env);
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain("Coinflip");
    const script = html.match(/src="\.\/(index-[a-z0-9]+\.js)"/);
    expect(script).not.toBeNull();
    const asset = await worker.fetch(new Request(`https://example.test/${script?.[1]}`), env);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("Content-Type")).toContain("javascript");
  });

  it("launches the Coinflip Activity without placing a chat wager", async () => {
    const response = await handleCommand(
      env,
      command("activity-launch", "coinflip", "activity-player", "activity-guild")
    );
    expect(response).toEqual({ type: 12 });
    expect(await transactionCount("activity-launch")).toBe(0);
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

  it("settles a Coin Flip wager exactly once", async () => {
    const interaction = coinFlip("coinflip-once", "coinflip-player", "coinflip-guild");
    const first = await handleCommand(env, interaction);
    const duplicate = await handleCommand(env, interaction);

    expect(first).toEqual(duplicate);
    expect(first.data?.content).toMatch(/coin landed on \*\*(Heads|Tails)\*\*/);
    expect(first.data?.content).toMatch(/New balance: \*\*(95|105)\*\*/);
    const player = await stats("coinflip-player", "coinflip-guild");
    expect([95, 105]).toContain(player.chips);
    expect(player.games).toBe(1);
    expect(await transactionCount(interaction.id)).toBe(1);
  });

  it("serializes concurrent duplicate Coin Flip deliveries", async () => {
    const interaction = coinFlip(
      "coinflip-concurrent",
      "concurrent-player",
      "concurrent-guild",
      10
    );
    const [first, duplicate] = await Promise.all([
      handleCommand(env, interaction),
      handleCommand(env, interaction),
    ]);

    expect(first).toEqual(duplicate);
    const player = await stats("concurrent-player", "concurrent-guild");
    expect([90, 110]).toContain(player.chips);
    expect(player.games).toBe(1);
    expect(await transactionCount(interaction.id)).toBe(1);
  });

  it("does not record or count an unaffordable wager", async () => {
    const interaction = coinFlip("coinflip-insufficient", "poor-player", "poor-guild", 101);
    const response = await handleCommand(env, interaction);

    expect(response.data?.content).toContain("don't have enough chips");
    expect(await stats("poor-player", "poor-guild")).toEqual({ chips: 100, games: 0 });
    expect(await transactionCount(interaction.id)).toBe(0);
  });

  it("makes daily claims retry-safe", async () => {
    const interaction = command("daily-once", "daily", "daily-player", "daily-guild");
    const first = await handleCommand(env, interaction);
    const duplicate = await handleCommand(env, interaction);
    const tooSoon = await handleCommand(
      env,
      command("daily-too-soon", "daily", "daily-player", "daily-guild")
    );

    expect(first).toEqual(duplicate);
    expect(first.data?.content).toContain("Balance: 600 chips");
    expect(tooSoon.data?.content).toContain("not ready");
    expect(await transactionCount(interaction.id)).toBe(1);
  });

  it("enforces database invariants", async () => {
    const economy = new EconomyRepository(env);
    await economy.balance("constraint-player", "constraint-guild");

    await expect(
      env.DB.prepare("UPDATE user_guild_stats SET chips = -1 WHERE user_id = ? AND guild_id = ?")
        .bind("constraint-player", "constraint-guild")
        .run()
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "INSERT INTO inventory_items (user_id, guild_id, item_id, quantity) VALUES (?, ?, ?, ?)"
      )
        .bind("missing-player", "missing-guild", 999, 1)
        .run()
    ).rejects.toThrow();
  });

  it("keeps one active roguelite run under concurrency", async () => {
    const runs = new RunRepository(env);
    const [first, concurrent] = await Promise.all([
      runs.resume("run-player", "run-guild"),
      runs.resume("run-player", "run-guild"),
    ]);

    expect(first).toBe(concurrent);
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM roguelite_runs WHERE user_id = ? AND guild_id = ? AND status = 'active'"
    )
      .bind("run-player", "run-guild")
      .first<{ count: number }>();
    expect(row?.count).toBe(1);
  });
});
