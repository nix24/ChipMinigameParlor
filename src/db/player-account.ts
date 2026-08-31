import type { Env } from "../env";

const STARTING_CHIPS = 100;

export async function initializePlayerAccount(
  env: Env,
  userId: string,
  guildId: string
): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)").bind(userId, now),
    env.DB.prepare("INSERT OR IGNORE INTO guilds (id, created_at) VALUES (?, ?)").bind(
      guildId,
      now
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO user_guild_stats (user_id, guild_id, chips, games_played) VALUES (?, ?, ?, 0)"
    ).bind(userId, guildId, STARTING_CHIPS),
  ]);
}
