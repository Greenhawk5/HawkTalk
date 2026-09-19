-- Phase 9: Admin CMS foundation — append-only audit log.
-- Admin authorization reuses users.role (Phase 8); no new identity tables.
-- admin_audit_logs is append-only: normal CMS operations never UPDATE or DELETE.
-- target_id is free of secrets (metadata identifiers only: user ids, provider
-- ids, credential ids, role names). detail is bounded safe metadata JSON.

CREATE TABLE admin_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER NOT NULL,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('OWNER', 'ADMIN')),
  action TEXT NOT NULL CHECK (length(action) >= 1 AND length(action) <= 64),
  target_type TEXT NOT NULL CHECK (length(target_type) >= 1 AND length(target_type) <= 32),
  target_id TEXT CHECK (target_id IS NULL OR length(target_id) <= 128),
  success INTEGER NOT NULL CHECK (success IN (0, 1)),
  detail TEXT NOT NULL DEFAULT '{}' CHECK (length(detail) <= 2000),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_admin_audit_created ON admin_audit_logs (created_at DESC, id DESC);
CREATE INDEX idx_admin_audit_actor ON admin_audit_logs (actor_user_id, created_at DESC);
