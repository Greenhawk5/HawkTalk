# Admin Panel (Telegram)

The admin panel is a single Telegram message per chat.

## Sessions
- `/admin` opens (or reuses) one panel message per chat and records a row in
  `admin_panel_sessions` (chat, message, owning admin, 5-minute inactivity
  expiry). Migration: `0011_admin_panel_sessions.sql`.
- Every button press EDITS that same message (`editMessageText`); nothing
  ever stacks a second panel message.
- Every callback must match BOTH the chat's live session message id AND the
  session's `telegram_user_id`; anything else is answered and rejected
  (fail closed). Authorization is still re-checked server-side per action.

## Expiry (5 minutes of inactivity)
- Every valid interaction refreshes `expires_at` (+5 min).
- A Worker `scheduled` handler (cron `* * * * *`, wrangler.toml `[triggers]`
  on all environments) deletes expired panels' Telegram messages
  (best-effort) and removes their session rows. Cleanup is idempotent: the
  session row is removed regardless of Telegram deletion outcome.
- No in-isolate timers are used for panel lifetime.

## Rendering conventions
- Admin views are Telegram HTML; all dynamic values escape through
  `src/telegram/format.ts` (`escapeHtml`), technical values render as
  `<code>` for copy-friendliness. Secrets never appear in any view.
- Keyboards: two-column main menu, `✕ Close` always a full-width final row.
- Provider configuration is never mutated via Telegram; the views point to
  the secure provisioning CLI so the same validation applies.
