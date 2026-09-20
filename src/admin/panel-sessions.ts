// Durable admin panel sessions (Telegram UX overhaul).
//
// One live admin panel message per chat. The session binds the panel message
// to the admin who opened it (actor + chat + message) and carries a 5-minute
// INACTIVITY expiry that is refreshed on every valid interaction. Expiry is
// enforced by the scheduled Worker handler (cron), never by in-isolate timers,
// so it is reliable across isolate restarts and request cancellation.
//
// Security properties:
// - Callbacks must match BOTH the chat's live session message id AND the
//   session's telegram_user_id; anything else is rejected (fail closed).
// - No secrets are stored: chat/message/user ids and timestamps only.
// - All statements are prepared and parameterized; timestamps are ISO strings
//   compared lexicographically (always UTC from the caller, as elsewhere).

export interface AdminPanelSession {
  chatId: number;
  messageId: number;
  telegramUserId: number;
  adminUserId: number;
  lastActivityAt: string;
  expiresAt: string;
}

/** Panel inactivity timeout: 5 minutes, refreshed on every valid interaction. */
export const PANEL_INACTIVITY_TTL_MS = 5 * 60 * 1000;

export function panelExpiryFrom(nowMs: number): { lastActivityAt: string; expiresAt: string } {
  const lastActivityAt = new Date(nowMs).toISOString();
  return { lastActivityAt, expiresAt: new Date(nowMs + PANEL_INACTIVITY_TTL_MS).toISOString() };
}

export async function getPanelSession(db: D1Database, chatId: number): Promise<AdminPanelSession | null> {
  const row = await db
    .prepare('SELECT chat_id, message_id, telegram_user_id, admin_user_id, last_activity_at, expires_at FROM admin_panel_sessions WHERE chat_id = ?')
    .bind(chatId)
    .first<Record<string, unknown>>();
  if (row === null) return null;
  const messageId = row['message_id'];
  const telegramUserId = row['telegram_user_id'];
  const adminUserId = row['admin_user_id'];
  const chatIdValue = row['chat_id'];
  const lastActivityAt = row['last_activity_at'];
  const expiresAt = row['expires_at'];
  if (
    typeof chatIdValue !== 'number' || typeof messageId !== 'number' || typeof telegramUserId !== 'number' ||
    typeof adminUserId !== 'number' || typeof lastActivityAt !== 'string' || typeof expiresAt !== 'string'
  ) {
    return null;
  }
  return { chatId: chatIdValue, messageId, telegramUserId, adminUserId, lastActivityAt, expiresAt };
}

/** Creates or replaces the chat's panel session (one panel per chat). */
export async function upsertPanelSession(
  db: D1Database,
  input: { chatId: number; messageId: number; telegramUserId: number; adminUserId: number; nowMs: number },
): Promise<void> {
  const { lastActivityAt, expiresAt } = panelExpiryFrom(input.nowMs);
  await db
    .prepare(
      `INSERT INTO admin_panel_sessions (chat_id, message_id, telegram_user_id, admin_user_id, created_at, last_activity_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (chat_id) DO UPDATE SET
         message_id = excluded.message_id,
         telegram_user_id = excluded.telegram_user_id,
         admin_user_id = excluded.admin_user_id,
         last_activity_at = excluded.last_activity_at,
         expires_at = excluded.expires_at`,
    )
    .bind(input.chatId, input.messageId, input.telegramUserId, input.adminUserId, lastActivityAt, lastActivityAt, expiresAt)
    .run();
}

/** Refreshes the inactivity window after a valid interaction. Idempotent. */
export async function touchPanelSession(db: D1Database, chatId: number, nowMs: number): Promise<void> {
  const { lastActivityAt, expiresAt } = panelExpiryFrom(nowMs);
  await db
    .prepare('UPDATE admin_panel_sessions SET last_activity_at = ?, expires_at = ? WHERE chat_id = ?')
    .bind(lastActivityAt, expiresAt, chatId)
    .run();
}

export async function deletePanelSession(db: D1Database, chatId: number): Promise<void> {
  await db.prepare('DELETE FROM admin_panel_sessions WHERE chat_id = ?').bind(chatId).run();
}

/** Expired sessions for the scheduled cleanup handler (bounded by expiry index). */
export async function listExpiredPanelSessions(db: D1Database, nowIso: string): Promise<Array<{ chatId: number; messageId: number }>> {
  const result = await db
    .prepare('SELECT chat_id, message_id FROM admin_panel_sessions WHERE expires_at <= ? LIMIT 100')
    .bind(nowIso)
    .all<Record<string, unknown>>();
  const out: Array<{ chatId: number; messageId: number }> = [];
  for (const row of result.results) {
    const chatId = row['chat_id'];
    const messageId = row['message_id'];
    if (typeof chatId === 'number' && typeof messageId === 'number') out.push({ chatId, messageId });
  }
  return out;
}
