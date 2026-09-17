-- Phase 2: Telegram transport tables.
-- users: one row per Telegram user, keyed by stable numeric Telegram user ID.
-- processed_updates: idempotency ledger keyed by Telegram update_id (PRIMARY KEY
-- gives an atomic claim: concurrent deliveries of the same update cannot both insert).

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id INTEGER NOT NULL UNIQUE,
  username TEXT,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

CREATE TABLE processed_updates (
  update_id INTEGER PRIMARY KEY,
  telegram_user_id INTEGER,
  kind TEXT NOT NULL,
  received_at TEXT NOT NULL
);
