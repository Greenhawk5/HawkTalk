// Scheduled admin panel cleanup (Telegram UX overhaul).
//
// The cron handler's single job: find panel sessions whose 5-minute inactivity
// window expired, delete their Telegram panel messages, remove the session
// rows, and send ONE bounded close notice per session.
//
// Consistency rules (fixed regression: the session used to be removed even
// when the Telegram delete failed, leaving a visible dead panel whose buttons
// could never work):
// - deleteMessage succeeds OR Telegram reports the message is already gone
//   ("message to delete not found") OR Telegram PERMANENTLY rejects the
//   delete  ->  delete the D1 session, send the close notice once. Session
//   removal is the de-duplication anchor: once the row is gone, a later cron
//   run can neither re-delete nor re-notify for the same session.
// - TRANSIENT failure (network / timeout / unusable response)  ->  keep the
//   session row so the next scheduled run retries; the expired row is still
//   matched by the expiry index. No unbounded in-process loop: one pass per
//   cron invocation, LIMIT 100 rows per pass, remaining rows continue on the
//   next minute's run.
// - One failing panel never blocks the others; every step is individually
//   caught. Logs carry only {event, chat_id, message_id} — never tokens,
//   headers, or raw payloads.

import { deleteMessage, sendTelegramMessage, TelegramApiRejection, TelegramSendError } from '../telegram/client';
import { deletePanelSession, listExpiredPanelSessions } from '../admin/panel-sessions';

/** Bounded, friendly close notice. Plain text; no admin controls inside. */
export const PANEL_CLOSED_NOTICE_TEXT = '⏱️ Admin panel closed due to 5 minutes of inactivity.';

/** Telegram's stable wording when the target message no longer exists. */
const MESSAGE_GONE_MARKERS = ['message to delete not found', 'message not found'];

type DeleteVerdict = 'deleted' | 'already_gone' | 'transient' | 'permanent';

function classifyDeleteFailure(error: unknown): DeleteVerdict {
  if (error instanceof TelegramApiRejection) {
    const description = error.telegramDescription.toLowerCase();
    if (MESSAGE_GONE_MARKERS.some((marker) => description.includes(marker))) return 'already_gone';
    // Telegram explicitly rejected the delete: retrying the identical request
    // cannot succeed, so this is permanent (fail-safe: the session is removed
    // so a stale panel can never be resurrected).
    return 'permanent';
  }
  // Network failure, timeout, or unusable response: the request may never
  // have reached Telegram. Transient — retry on the next scheduled run.
  if (error instanceof TelegramSendError) return 'transient';
  return 'transient';
}

async function deletePanelMessage(
  botToken: string,
  chatId: number,
  messageId: number,
  fetchImpl: typeof fetch | undefined,
): Promise<DeleteVerdict> {
  try {
    await deleteMessage({ token: botToken, chatId, messageId, ...(fetchImpl !== undefined ? { fetchImpl } : {}) });
    return 'deleted';
  } catch (error) {
    return classifyDeleteFailure(error);
  }
}

export async function cleanupExpiredPanels(
  db: D1Database,
  botToken: string | undefined,
  fetchImpl?: typeof fetch,
  now: () => string = () => new Date().toISOString(),
): Promise<number> {
  if (typeof botToken !== 'string' || botToken.length === 0) return 0;
  const nowIso = now();
  const expired = await listExpiredPanelSessions(db, nowIso).catch(() => {
    // Never silently swallow a session-table read failure (e.g. a missing
    // admin_panel_sessions table): it must be visible in the tail.
    console.error(JSON.stringify({ event: 'admin_panel_cleanup_read_failed', current_time: nowIso }));
    return [];
  });
  console.log(JSON.stringify({ event: 'admin_panel_cleanup_started', current_time: nowIso, candidate_count: expired.length }));
  let cleaned = 0;
  for (const session of expired) {
    console.log(JSON.stringify({ event: 'admin_panel_cleanup_decision', chat_id: session.chatId, message_id: session.messageId, reason: 'expired' }));
    try {
      const verdict = await deletePanelMessage(botToken, session.chatId, session.messageId, fetchImpl);
      if (verdict === 'transient') {
        // Keep the session row: it stays expired in D1, so the next cron run
        // retries the delete. The panel may still be visible meanwhile — any
        // interaction with it is rejected by the session expiry check.
        console.error(JSON.stringify({ event: 'admin_panel_message_delete_failed', chat_id: session.chatId, message_id: session.messageId }));
        continue;
      }
      // Session removal first (idempotency anchor), then best-effort notice:
      // a notice failure must never cause a duplicate notice on the next run.
      await deletePanelSession(db, session.chatId).catch(() => undefined);
      if (verdict === 'deleted') {
        console.log(JSON.stringify({ event: 'admin_panel_message_deleted', chat_id: session.chatId, message_id: session.messageId }));
      } else {
        console.log(JSON.stringify({ event: 'admin_panel_message_already_gone', chat_id: session.chatId, message_id: session.messageId }));
      }
      console.log(JSON.stringify({ event: 'admin_panel_expired', chat_id: session.chatId }));
      try {
        await sendTelegramMessage({ token: botToken, chatId: session.chatId, text: PANEL_CLOSED_NOTICE_TEXT, ...(fetchImpl !== undefined ? { fetchImpl } : {}) });
        console.log(JSON.stringify({ event: 'admin_panel_expiration_notice_sent', chat_id: session.chatId }));
      } catch {
        console.error(JSON.stringify({ event: 'admin_panel_expiration_notice_failed', chat_id: session.chatId }));
      }
      cleaned += 1;
    } catch {
      // Never let one panel block the rest of the batch.
      console.error(JSON.stringify({ event: 'admin_panel_cleanup_item_failed', chat_id: session.chatId }));
    }
  }
  return cleaned;
}
