import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
export const guilds = sqliteTable("guilds", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
export const userGuildStats = sqliteTable(
  "user_guild_stats",
  {
    userId: text("user_id").notNull(),
    guildId: text("guild_id").notNull(),
    chips: integer("chips").notNull().default(100),
    gamesPlayed: integer("games_played").notNull().default(0),
    lastDailyClaimedAt: integer("last_daily_claimed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.guildId] }),
    index("user_guild_stats_leaderboard").on(table.guildId, table.chips),
    index("user_guild_stats_games").on(table.guildId, table.gamesPlayed),
  ]
);
export const items = sqliteTable("items", {
  id: integer("id").primaryKey(),
  name: text("name").notNull().unique(),
  baseValue: integer("base_value").notNull().default(0),
  kind: text("kind").notNull().default("JUNK"),
});
export const inventoryItems = sqliteTable(
  "inventory_items",
  {
    userId: text("user_id").notNull(),
    itemId: integer("item_id").notNull(),
    quantity: integer("quantity").notNull().default(1),
  },
  (table) => [primaryKey({ columns: [table.userId, table.itemId] })]
);
export const rogueliteRuns = sqliteTable(
  "roguelite_runs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    guildId: text("guild_id").notNull(),
    state: text("state", { mode: "json" }).notNull(),
    status: text("status").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("roguelite_runs_player").on(table.userId, table.guildId, table.status)]
);
export const gameSettlements = sqliteTable("game_settlements", {
  gameId: text("game_id").primaryKey(),
  guildId: text("guild_id").notNull(),
  settledAt: integer("settled_at", { mode: "timestamp_ms" }).notNull(),
});
