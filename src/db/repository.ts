import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../env";
import { rogueliteRuns, userGuildStats } from "./schema";

const STARTING_CHIPS = 100;
const DAILY_CHIPS = 500;
const DAY_MS = 86_400_000;

export class EconomyRepository {
  private readonly db;
  constructor(private readonly env: Env) {
    this.db = drizzle(env.DB);
  }

  async balance(userId: string, guildId: string): Promise<number> {
    await this.ensurePlayer(userId, guildId);
    const result = await this.db
      .select({ chips: userGuildStats.chips })
      .from(userGuildStats)
      .where(and(eq(userGuildStats.userId, userId), eq(userGuildStats.guildId, guildId)))
      .get();
    return result?.chips ?? STARTING_CHIPS;
  }

  async claimDaily(
    userId: string,
    guildId: string,
    now = Date.now()
  ): Promise<{ claimed: boolean; chips: number }> {
    await this.ensurePlayer(userId, guildId);
    const cutoff = now - DAY_MS;
    const result = await this.env.DB.prepare(
      "UPDATE user_guild_stats SET chips = chips + ?, last_daily_claimed_at = ? WHERE user_id = ? AND guild_id = ? AND (last_daily_claimed_at IS NULL OR last_daily_claimed_at <= ?) RETURNING chips"
    )
      .bind(DAILY_CHIPS, now, userId, guildId, cutoff)
      .first<{ chips: number }>();
    return result
      ? { claimed: true, chips: result.chips }
      : { claimed: false, chips: await this.balance(userId, guildId) };
  }

  async settleCoinFlip(
    userId: string,
    guildId: string,
    stake: number,
    won: boolean
  ): Promise<{ settled: boolean; chips: number }> {
    await this.ensurePlayer(userId, guildId);
    const result = await this.env.DB.prepare(
      "UPDATE user_guild_stats SET chips = chips + ?, games_played = games_played + 1 WHERE user_id = ? AND guild_id = ? AND chips >= ? RETURNING chips"
    )
      .bind(won ? stake : -stake, userId, guildId, stake)
      .first<{ chips: number }>();
    return result
      ? { settled: true, chips: result.chips }
      : { settled: false, chips: await this.balance(userId, guildId) };
  }

  async leaderboard(guildId: string): Promise<Array<{ userId: string; chips: number }>> {
    return this.db
      .select({ userId: userGuildStats.userId, chips: userGuildStats.chips })
      .from(userGuildStats)
      .where(eq(userGuildStats.guildId, guildId))
      .orderBy(desc(userGuildStats.chips))
      .limit(10)
      .all();
  }

  async resumeRun(userId: string, guildId: string): Promise<string> {
    const run = await this.db
      .select({ id: rogueliteRuns.id })
      .from(rogueliteRuns)
      .where(
        and(
          eq(rogueliteRuns.userId, userId),
          eq(rogueliteRuns.guildId, guildId),
          eq(rogueliteRuns.status, "active")
        )
      )
      .get();
    if (run) return run.id;
    const id = crypto.randomUUID();
    await this.db.insert(rogueliteRuns).values({
      id,
      userId,
      guildId,
      state: { floor: 1, health: 100 },
      status: "active",
      updatedAt: new Date(),
    });
    return id;
  }

  private async ensurePlayer(userId: string, guildId: string): Promise<void> {
    const now = new Date();
    await this.env.DB.batch([
      this.env.DB.prepare("INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)").bind(
        userId,
        now.getTime()
      ),
      this.env.DB.prepare("INSERT OR IGNORE INTO guilds (id, created_at) VALUES (?, ?)").bind(
        guildId,
        now.getTime()
      ),
      this.env.DB.prepare(
        "INSERT OR IGNORE INTO user_guild_stats (user_id, guild_id, chips, games_played) VALUES (?, ?, ?, 0)"
      ).bind(userId, guildId, STARTING_CHIPS),
    ]);
  }
}
