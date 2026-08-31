import { desc, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const MAX_CHIPS = Number.MAX_SAFE_INTEGER;

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
    foreignKey({ columns: [table.userId], foreignColumns: [users.id] }).onDelete("cascade"),
    foreignKey({ columns: [table.guildId], foreignColumns: [guilds.id] }).onDelete("cascade"),
    check("user_guild_stats_chips_range", sql`${table.chips} BETWEEN 0 AND ${MAX_CHIPS}`),
    check("user_guild_stats_games_nonnegative", sql`${table.gamesPlayed} >= 0`),
    index("user_guild_stats_leaderboard").on(table.guildId, desc(table.chips), table.userId),
  ]
);
export const items = sqliteTable(
  "items",
  {
    id: integer("id").primaryKey(),
    name: text("name").notNull().unique(),
    baseValue: integer("base_value").notNull().default(0),
    kind: text("kind").notNull().default("JUNK"),
  },
  (table) => [
    check("items_name_nonempty", sql`length(${table.name}) > 0`),
    check("items_base_value_range", sql`${table.baseValue} BETWEEN 0 AND ${MAX_CHIPS}`),
    check("items_kind_nonempty", sql`length(${table.kind}) > 0`),
  ]
);
export const inventoryItems = sqliteTable(
  "inventory_items",
  {
    userId: text("user_id").notNull(),
    guildId: text("guild_id").notNull(),
    itemId: integer("item_id").notNull(),
    quantity: integer("quantity").notNull().default(1),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.guildId, table.itemId] }),
    foreignKey({
      columns: [table.userId, table.guildId],
      foreignColumns: [userGuildStats.userId, userGuildStats.guildId],
    }).onDelete("cascade"),
    foreignKey({ columns: [table.itemId], foreignColumns: [items.id] }).onDelete("cascade"),
    check("inventory_items_quantity_positive", sql`${table.quantity} > 0`),
  ]
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
  (table) => [
    foreignKey({
      columns: [table.userId, table.guildId],
      foreignColumns: [userGuildStats.userId, userGuildStats.guildId],
    }).onDelete("cascade"),
    check("roguelite_runs_state_json", sql`json_valid(${table.state})`),
    check("roguelite_runs_status_nonempty", sql`length(${table.status}) > 0`),
    uniqueIndex("roguelite_runs_one_active")
      .on(table.userId, table.guildId)
      .where(sql`${table.status} = 'active'`),
    index("roguelite_runs_player").on(table.userId, table.guildId, table.status),
  ]
);

export const chipTransactions = sqliteTable(
  "chip_transactions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    guildId: text("guild_id").notNull(),
    source: text("source").notNull(),
    game: text("game"),
    requestFingerprint: text("request_fingerprint").notNull(),
    stake: integer("stake").notNull().default(0),
    payout: integer("payout").notNull().default(0),
    delta: integer("delta").notNull(),
    balanceBefore: integer("balance_before").notNull(),
    balanceAfter: integer("balance_after").notNull(),
    result: text("result").notNull(),
    applied: integer("applied", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId, table.guildId],
      foreignColumns: [userGuildStats.userId, userGuildStats.guildId],
    }).onDelete("restrict"),
    check("chip_transactions_source_nonempty", sql`length(${table.source}) > 0`),
    check("chip_transactions_request_nonempty", sql`length(${table.requestFingerprint}) > 0`),
    check("chip_transactions_stake_range", sql`${table.stake} BETWEEN 0 AND ${MAX_CHIPS}`),
    check("chip_transactions_payout_range", sql`${table.payout} BETWEEN 0 AND ${MAX_CHIPS}`),
    check(
      "chip_transactions_delta_matches",
      sql`${table.delta} = ${table.payout} - ${table.stake}`
    ),
    check(
      "chip_transactions_balance_before_range",
      sql`${table.balanceBefore} BETWEEN 0 AND ${MAX_CHIPS}`
    ),
    check(
      "chip_transactions_balance_after_range",
      sql`${table.balanceAfter} BETWEEN 0 AND ${MAX_CHIPS}`
    ),
    check(
      "chip_transactions_balance_matches",
      sql`${table.balanceAfter} = ${table.balanceBefore} + ${table.delta}`
    ),
    check("chip_transactions_result_nonempty", sql`length(${table.result}) > 0`),
    check("chip_transactions_applied_boolean", sql`${table.applied} IN (0, 1)`),
    index("chip_transactions_history").on(table.userId, table.guildId, desc(table.createdAt)),
  ]
);
