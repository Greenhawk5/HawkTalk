-- Admin panel sessions (Telegram UX overhaul): one live admin panel message
-- per chat. Enables same-message navigation (editMessageText), panel
-- ownership binding (actor + chat + message), and a 5-minute INACTIVITY
-- timeout enforced by the scheduled Worker handler (never by in-isolate
-- timers). No secrets are stored: identifiers and timestamps only.
CREATE TABLE admin_panel_sessions (
  chat_id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL,
  telegram_user_id INTEGER NOT NULL,
  admin_user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_admin_panel_expiry ON admin_panel_sessions (expires_at);
