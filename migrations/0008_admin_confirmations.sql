-- Phase 9 (hardening): durable destructive-action confirmations.
-- Each row binds ONE actor to ONE action to ONE target, is single-use
-- (used_at), short-lived (expires_at), and lives in D1 so it survives Worker
-- isolate loss. No secrets are stored: payload holds only validated
-- mutation parameters (ids, roles, statuses). Expired/consumed rows are
-- garbage-collected opportunistically.

CREATE TABLE admin_confirmations (
  id TEXT PRIMARY KEY,
  actor_user_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (length(action) >= 1 AND length(action) <= 64),
  target_type TEXT NOT NULL CHECK (length(target_type) >= 1 AND length(target_type) <= 32),
  target_id TEXT NOT NULL CHECK (length(target_id) >= 1 AND length(target_id) <= 128),
  payload TEXT NOT NULL DEFAULT '{}' CHECK (length(payload) <= 2000),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX idx_admin_confirmations_actor ON admin_confirmations (actor_user_id, created_at DESC);
CREATE INDEX idx_admin_confirmations_expiry ON admin_confirmations (expires_at);