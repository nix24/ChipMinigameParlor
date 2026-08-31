PRAGMA defer_foreign_keys = ON;

CREATE TABLE user_guild_stats_new (
  user_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  chips INTEGER NOT NULL DEFAULT 100 CHECK (chips BETWEEN 0 AND 9007199254740991),
  games_played INTEGER NOT NULL DEFAULT 0 CHECK (games_played >= 0),
  last_daily_claimed_at INTEGER,
  PRIMARY KEY (user_id, guild_id),
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  FOREIGN KEY (guild_id) REFERENCES guilds (id) ON DELETE CASCADE
);

INSERT INTO user_guild_stats_new (
  user_id,
  guild_id,
  chips,
  games_played,
  last_daily_claimed_at
)
SELECT user_id, guild_id, chips, games_played, last_daily_claimed_at
FROM user_guild_stats;

DROP TABLE user_guild_stats;
ALTER TABLE user_guild_stats_new RENAME TO user_guild_stats;
CREATE INDEX user_guild_stats_leaderboard
  ON user_guild_stats (guild_id, chips DESC, user_id);

CREATE TABLE items_new (
  id INTEGER PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE CHECK (length(name) > 0),
  base_value INTEGER NOT NULL DEFAULT 0 CHECK (base_value BETWEEN 0 AND 9007199254740991),
  kind TEXT NOT NULL DEFAULT 'JUNK' CHECK (length(kind) > 0)
);

INSERT INTO items_new (id, name, base_value, kind)
SELECT id, name, base_value, kind
FROM items;

DROP TABLE items;
ALTER TABLE items_new RENAME TO items;

CREATE TABLE inventory_items_new (
  user_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  PRIMARY KEY (user_id, guild_id, item_id),
  FOREIGN KEY (user_id, guild_id)
    REFERENCES user_guild_stats (user_id, guild_id)
    ON DELETE CASCADE,
  FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE
);

INSERT INTO inventory_items_new (user_id, guild_id, item_id, quantity)
SELECT inventory.user_id, stats.guild_id, inventory.item_id, inventory.quantity
FROM inventory_items AS inventory
JOIN user_guild_stats AS stats ON stats.user_id = inventory.user_id;

DROP TABLE inventory_items;
ALTER TABLE inventory_items_new RENAME TO inventory_items;

CREATE TABLE roguelite_runs_new (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (json_valid(state)),
  status TEXT NOT NULL CHECK (length(status) > 0),
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id, guild_id)
    REFERENCES user_guild_stats (user_id, guild_id)
    ON DELETE CASCADE
);

INSERT INTO roguelite_runs_new (id, user_id, guild_id, state, status, updated_at)
SELECT id, user_id, guild_id, state, status, updated_at
FROM roguelite_runs;

DROP TABLE roguelite_runs;
ALTER TABLE roguelite_runs_new RENAME TO roguelite_runs;
CREATE UNIQUE INDEX roguelite_runs_one_active
  ON roguelite_runs (user_id, guild_id)
  WHERE status = 'active';
CREATE INDEX roguelite_runs_player
  ON roguelite_runs (user_id, guild_id, status);

DROP TABLE game_settlements;

CREATE TABLE chip_transactions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (length(source) > 0),
  game TEXT,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) > 0),
  stake INTEGER NOT NULL DEFAULT 0 CHECK (stake BETWEEN 0 AND 9007199254740991),
  payout INTEGER NOT NULL DEFAULT 0 CHECK (payout BETWEEN 0 AND 9007199254740991),
  delta INTEGER NOT NULL CHECK (delta = payout - stake),
  balance_before INTEGER NOT NULL CHECK (balance_before BETWEEN 0 AND 9007199254740991),
  balance_after INTEGER NOT NULL CHECK (balance_after BETWEEN 0 AND 9007199254740991),
  result TEXT NOT NULL CHECK (length(result) > 0),
  applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1)),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id, guild_id)
    REFERENCES user_guild_stats (user_id, guild_id)
    ON DELETE RESTRICT,
  CHECK (balance_after = balance_before + delta)
);

CREATE INDEX chip_transactions_history
  ON chip_transactions (user_id, guild_id, created_at DESC);

PRAGMA optimize;
