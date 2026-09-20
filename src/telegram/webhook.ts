import { claimUpdate, releaseUpdateClaim, upsertTelegramUser } from '../db/telegram';
import { findInternalUserIdByTelegramId } from '../db/users';
import { deletePanelSession, getPanelSession, touchPanelSession, upsertPanelSession } from '../admin/panel-sessions';
import type { AdminPanelSession } from '../admin/panel-sessions';
import type { ConversationFlowDeps } from '../orchestration/service';
import { ConversationFlowError, getCompletedAssistantText, handleUserTextMessage, PRE_GENERATION_ERROR_KINDS } from '../orchestration/service';
import type { AppEnv } from '../env';
import { sendTelegramMessage, editMessageText, deleteMessage, answerCallbackQuery, type TelegramInlineKeyboard } from './client';
import { parseTelegramUpdate } from './parser';
import { TRANSPORT_ACK_TEXT } from './ack';
import { ADMIN_COMMAND, type AdminView } from './admin-ui';
import { MODE_COMMAND_USAGE_HINT, parseUserCommand } from './user-commands';
import { handleAdminCallback, handleAdminCommand } from './admin-handler';
import type { AdminOutcome } from './admin-handler';
import type { AdminService } from '../admin/service';
import { parseMemoryCommand, handleMemoryCommand } from './memory-commands';
import { buildProductionMemoryService } from '../orchestration/production';
import { isControlPlaneCommand, handleControlPlaneCommand } from './control-plane';
import './types';

// Telegram webhook entrypoint (Phase 2 transport + Phase 6 conversational flow).
//
// Pipeline:
//   POST + secret-token check -> bounded body read -> JSON parse ->
//   update_id validation -> atomic idempotency claim -> private-chat text
//   messages run the conversational flow (internal user → default conversation
//   → persist user message → bounded history → Agent Core → AI Router →
//   persist assistant reply → Telegram reply); everything else is acknowledged.
//
// Durable idempotency (Phase 6, approved):
// - The Phase 2 claim row now carries a processing state. Once the flow marks
//   an update 'generating', redelivery NEVER regenerates: completed updates
//   reuse the persisted assistant message for delivery; failed/uncertain
//   updates are acknowledged without AI.
// - Telegram sendMessage is at-least-once: the same assistant text may
//   occasionally be delivered twice when a send times out after reaching
//   Telegram. Generation, user-message persistence, and assistant-message
//   persistence remain idempotent per update_id.
//
// Security properties (unchanged):
// - Every failure mode returns a generic body; logs carry only {event,
//   request_id}. The bot token, webhook secret, message text, and upstream
//   error details never enter logs or responses.
// - Missing server-side secrets fail closed (500), never open.

export const TELEGRAM_WEBHOOK_PATH = '/telegram/webhook';
const WEBHOOK_SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token';
const MAX_BODY_BYTES = 256 * 1024;

// Admin panel delivery (Phase 10 UX). These helpers are transport-only:
// authorization and all business rules stay in handleAdminCallback /
// AdminService (which re-authorize every operation against current D1 state).

/** Short bounded text sent via answerCallbackQuery for panel session problems. */
const PANEL_EXPIRED_TEXT = 'This panel has expired. Send /admin to reopen it.';
const PANEL_CLOSED_TEXT = '⏱️ Admin panel closed due to inactivity.';
/** D1/session infrastructure failure (NOT an expired panel): distinct, actionable. */
const PANEL_UNAVAILABLE_TEXT = 'The admin panel is temporarily unavailable. Send /admin again in a moment.';
const PANEL_FOREIGN_TEXT = 'This panel belongs to another admin.';
const PANEL_UPDATE_FAILED_TEXT = 'The panel could not be updated. Send /admin to reopen it.';

type PanelView = Pick<AdminView, 'text' | 'keyboard' | 'parseMode'>;

function viewMarkup(view: PanelView): TelegramInlineKeyboard {
  return { inline_keyboard: view.keyboard.map((row) => row.map((button) => ({ text: button.text, callback_data: button.callbackData }))) };
}

interface EditCall {
  token: string;
  chatId: number;
  messageId: number;
  text: string;
  replyMarkup: TelegramInlineKeyboard;
  parseMode?: 'HTML' | undefined;
  fetchImpl?: typeof fetch | undefined;
}

/** /admin text command: exactly one panel message per chat. */
async function openAdminPanel(
  db: D1Database,
  botToken: string,
  nowMs: number,
  chatId: number,
  telegramUserId: number,
  internalUserId: number | null,
  outcome: Extract<AdminOutcome, { kind: 'view' }>,
  requestId: string,
  fetchImpl: typeof fetch | undefined,
  editCall: (input: EditCall) => Promise<void>,
): Promise<void> {
  const view = outcome.view satisfies PanelView;
  const markup = viewMarkup(view);
  const nowIso = Number.isFinite(nowMs) ? new Date(nowMs).toISOString() : undefined;
  console.log(JSON.stringify({ event: 'admin_panel_open_requested', chat_id: chatId, telegram_user_id: telegramUserId, current_time: nowIso ?? null }));
  // A live session owned by this admin → reuse the same panel message.
  // A READ FAILURE (e.g. missing table / D1 outage) is logged distinctly and
  // treated as "no session" — but never silently.
  const existing = await getPanelSession(db, chatId).catch(() => {
    console.error(JSON.stringify({ event: 'admin_panel_session_read_failed', chat_id: chatId }));
    return null;
  });
  if (existing !== null) {
    console.log(JSON.stringify({
      event: 'admin_panel_session_found',
      chat_id: existing.chatId,
      session_message_id: existing.messageId,
      telegram_user_id: existing.telegramUserId,
      admin_user_id: existing.adminUserId,
      last_activity_at: existing.lastActivityAt,
      expires_at: existing.expiresAt,
      remaining_ms: nowIso === undefined ? null : Date.parse(existing.expiresAt) - Date.parse(nowIso),
    }));
  } else {
    console.log(JSON.stringify({ event: 'admin_panel_session_missing', chat_id: chatId }));
  }
  const reuseEligible = existing !== null && existing.telegramUserId === telegramUserId && (nowIso === undefined || existing.expiresAt > nowIso);
  console.log(JSON.stringify({
    event: 'admin_panel_reuse_decision',
    chat_id: chatId,
    session_message_id: existing?.messageId ?? null,
    reason: existing === null ? 'no_session'
      : !reuseEligible && existing.telegramUserId !== telegramUserId ? 'ownership_mismatch'
      : !reuseEligible ? 'expired_session'
      : 'valid_session',
  }));
  if (reuseEligible) {
    try {
      await editCall({ token: botToken, chatId, messageId: existing.messageId, text: view.text, replyMarkup: markup, ...(view.parseMode !== undefined ? { parseMode: view.parseMode } : {}) });
      if (Number.isFinite(nowMs)) await touchPanelSession(db, chatId, nowMs).catch((error: unknown) => {
        console.error(JSON.stringify({ event: 'admin_panel_touch_failed', chat_id: chatId }));
        void error;
      });
      console.log(JSON.stringify({ event: 'admin_panel_reused', chat_id: chatId, message_id: existing.messageId }));
      return;
    } catch {
      // Stale session (message deleted externally): the old panel is gone from
      // Telegram but its row still points at it — remove it and open fresh.
      console.log(JSON.stringify({ event: 'admin_panel_reuse_decision', chat_id: chatId, session_message_id: existing.messageId, reason: 'edit_failed' }));
      await deletePanelSession(db, chatId).catch(() => undefined);
    }
  } else if (existing !== null && (nowIso === undefined || existing.expiresAt <= nowIso)) {
    // The session expired but the old panel message is still visible in
    // Telegram. Delete it BEFORE opening the new panel, otherwise the orphaned
    // panel keeps rendering dead buttons ("This panel has expired") forever.
    // Best-effort: if the delete fails here, the cron cleanup retries it only
    // while the session row still existed — it is replaced below, so also
    // remove the row to avoid the cron deleting the NEW panel message.
    await deleteMessage({ token: botToken, chatId, messageId: existing.messageId, ...(fetchImpl !== undefined ? { fetchImpl } : {}) }).catch(() => {
      console.error(JSON.stringify({ event: 'admin_panel_message_delete_failed', chat_id: chatId, message_id: existing.messageId }));
    });
    await deletePanelSession(db, chatId).catch(() => undefined);
  }
  const sent = await sendTelegramMessage({ token: botToken, chatId, text: view.text, replyMarkup: markup, ...(view.parseMode !== undefined ? { parseMode: view.parseMode } : {}), ...(fetchImpl !== undefined ? { fetchImpl } : {}) });
  console.log(JSON.stringify({ event: 'telegram_send_message_success', chat_id: chatId, message_id: sent.messageId }));
  if (internalUserId !== null && sent.messageId !== null && Number.isFinite(nowMs)) {
    // Persist, then VERIFY the row is actually readable — a failed INSERT must
    // never be silently swallowed (it previously produced a dead-on-arrival
    // panel whose buttons all answered "expired", while the created log lied).
    try {
      await upsertPanelSession(db, { chatId, messageId: sent.messageId, telegramUserId, adminUserId: internalUserId, nowMs });
    } catch {
      console.error(JSON.stringify({ event: 'admin_panel_session_persist_failed', chat_id: chatId, message_id: sent.messageId, admin_user_id: internalUserId }));
    }
    const persisted = await getPanelSession(db, chatId).catch(() => null);
    if (persisted !== null && persisted.messageId === sent.messageId) {
      console.log(JSON.stringify({ event: 'admin_panel_session_persisted', chat_id: chatId, message_id: persisted.messageId, expires_at: persisted.expiresAt, last_activity_at: persisted.lastActivityAt }));
    } else {
      console.error(JSON.stringify({ event: 'admin_panel_session_persist_failed', chat_id: chatId, message_id: sent.messageId, admin_user_id: internalUserId }));
    }
    console.log(JSON.stringify({ event: 'admin_panel_created', chat_id: chatId, message_id: sent.messageId }));
  } else {
    console.error(JSON.stringify({ event: 'webhook_panel_session_skipped', request_id: requestId }));
  }
}

/** Admin button presses: validate the durable panel session, then edit/close. */
async function handleAdminPanelCallback(
  options: {
    db: D1Database;
    botToken: string;
    nowMs: number;
    chatId: number;
    telegramUserId: number;
    messageId: number;
    data: string;
    requestId: string;
    adminService: AdminService;
    editCall: (input: EditCall) => Promise<void>;
    answerCall: (text?: string) => Promise<unknown>;
    deleteCall: (messageId: number) => Promise<void>;
  },
): Promise<Response> {
  const { db, botToken, nowMs, chatId, telegramUserId, messageId, data, requestId, adminService, editCall, answerCall, deleteCall } = options;
  console.log(JSON.stringify({
    event: 'admin_panel_callback_received',
    callback_query_id: requestId,
    telegram_user_id: telegramUserId,
    callback_chat_id: chatId,
    callback_message_id: messageId,
  }));
  // A D1 READ FAILURE is NOT an expired panel. Treating it as "expired" (the
  // old behavior) produced the misleading production toast while the real
  // cause — e.g. a missing admin_panel_sessions table — stayed invisible.
  const read = await getPanelSession(db, chatId).then(
    (value: AdminPanelSession | null) => ({ ok: true as const, value }),
    (): { ok: false } => ({ ok: false }),
  );
  if (!read.ok) {
    console.error(JSON.stringify({ event: 'admin_panel_session_read_failed', lookup_chat_id: chatId, callback_message_id: messageId }));
    await answerCall(PANEL_UNAVAILABLE_TEXT);
    return Response.json({ ok: true });
  }
  const session = read.value;
  console.log(JSON.stringify({
    event: 'admin_panel_callback_session_lookup',
    lookup_chat_id: chatId,
    lookup_message_id: messageId,
    found: session !== null,
    stored_chat_id: session?.chatId ?? null,
    stored_message_id: session?.messageId ?? null,
    stored_expires_at: session?.expiresAt ?? null,
    now: Number.isFinite(nowMs) ? new Date(nowMs).toISOString() : null,
    remaining_ms: session !== null && Number.isFinite(nowMs) ? Date.parse(session.expiresAt) - nowMs : null,
  }));
  if (session === null || session.messageId !== messageId) {
    // No live panel for this chat, or a stale button from a replaced panel:
    // never execute, never touch state.
    console.log(JSON.stringify({ event: 'admin_panel_callback_rejected', lookup_chat_id: chatId, lookup_message_id: messageId, reason: session === null ? 'no_session' : 'message_mismatch' }));
    await answerCall(PANEL_EXPIRED_TEXT);
    return Response.json({ ok: true });
  }
  if (session.telegramUserId !== telegramUserId) {
    // A second Telegram user pressed a button they obtained somehow: deny
    // without executing anything and without touching the session.
    console.error(JSON.stringify({ event: 'admin_panel_foreign_user', request_id: requestId }));
    await answerCall(PANEL_FOREIGN_TEXT);
    return Response.json({ ok: true });
  }
  if (!Number.isFinite(nowMs) || session.expiresAt <= new Date(nowMs).toISOString()) {
    // Inactivity timeout reached before cron cleanup ran: the panel message is
    // deleted (never edited into an "expired" screen) and the session drops.
    // The cron sends the friendly close notice; this path answers the press
    // defensively without executing any admin action.
    console.log(JSON.stringify({ event: 'admin_panel_callback_rejected', lookup_chat_id: chatId, lookup_message_id: messageId, reason: 'expired', stored_expires_at: session.expiresAt }));
    await deleteCall(session.messageId).catch(() => undefined);
    await deletePanelSession(db, chatId).catch(() => undefined);
    console.log(JSON.stringify({ event: 'admin_panel_expired', chat_id: chatId, message_id: session.messageId }));
    await answerCall(PANEL_CLOSED_TEXT);
    return Response.json({ ok: true });
  }

  // Live panel owned by this admin: execution re-authorizes everything
  // server-side (checkAccess + service-level auth); buttons are never trusted.
  const outcome = await handleAdminCallback(db, adminService, telegramUserId, data);
  if (outcome.kind === 'close') {
    await deleteCall(session.messageId).catch(() => undefined);
    await deletePanelSession(db, chatId).catch(() => undefined);
    await answerCall();
    return Response.json({ ok: true });
  }
  if (outcome.kind === 'answer') {
    if (Number.isFinite(nowMs)) await touchPanelSession(db, chatId, nowMs).catch(() => undefined);
    await answerCall(outcome.text);
    return Response.json({ ok: true });
  }
  try {
    await editCall({ token: botToken, chatId, messageId: session.messageId, text: outcome.view.text, replyMarkup: viewMarkup(outcome.view satisfies PanelView), ...(outcome.view.parseMode !== undefined ? { parseMode: outcome.view.parseMode } : {}) });
  } catch {
    // The panel message is gone or Telegram rejected the edit: drop the stale
    // session so the next press reopens cleanly; never leak internals.
    console.error(JSON.stringify({ event: 'webhook_panel_edit_failed', request_id: requestId }));
    await deletePanelSession(db, chatId).catch(() => undefined);
    await answerCall(PANEL_UPDATE_FAILED_TEXT);
    return Response.json({ ok: true });
  }
  if (Number.isFinite(nowMs)) await touchPanelSession(db, chatId, nowMs).catch(() => undefined);
  await answerCall();
  return Response.json({ ok: true });
}

export interface WebhookDeps {
  fetchImpl?: typeof fetch | undefined;
  now?: (() => string) | undefined;
  /** Fully wired conversational dependencies; production composes D1 + AI Router. */
  flow?: ConversationFlowFactory | undefined;
  /** Phase 9 admin CMS; when absent, admin updates are acknowledged (fail closed). */
  adminService?: AdminService | undefined;
  /**
   * Cloudflare background execution (ExecutionContext.waitUntil). When
   * provided, the webhook responds 200 immediately after the durable claim
   * and the conversational processing (user upsert, Agent Core, AI Router,
   * persistence, Telegram delivery) continues under waitUntil — so a slow
   * provider generation (e.g. a 60s provider timeout_ms) can never race the
   * ~60s Telegram webhook deadline that cancels the request. When absent,
   * processing stays fully synchronous (legacy behavior preserved for tests).
   */
  waitUntil?: ((promise: Promise<unknown>) => void) | undefined;
}

export type ConversationFlowFactory = (requestId: string, internalUserId: number) => ConversationFlowDeps;

// Constant-time comparison over UTF-8 bytes so the secret check does not leak
// prefix information through timing. Lengths are folded into the accumulator.
export function timingSafeEqualString(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i += 1) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

export async function handleTelegramWebhook(
  request: Request,
  env: Partial<AppEnv>,
  requestId: string,
  deps: WebhookDeps = {},
): Promise<Response> {
  const now = deps.now ?? (() => new Date().toISOString());

  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'POST' } });
  }

  const serverSecret = env.TELEGRAM_WEBHOOK_SECRET;
  if (typeof serverSecret !== 'string' || serverSecret.length === 0) {
    console.error(JSON.stringify({ event: 'webhook_misconfigured', request_id: requestId }));
    return Response.json({ error: 'Something went wrong' }, { status: 500 });
  }
  const presentedSecret = request.headers.get(WEBHOOK_SECRET_HEADER);
  if (presentedSecret === null || !timingSafeEqualString(presentedSecret, serverSecret)) {
    console.error(JSON.stringify({ event: 'webhook_unauthorized', request_id: requestId }));
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    console.error(JSON.stringify({ event: 'webhook_bad_request', request_id: requestId }));
    return Response.json({ error: 'Bad request' }, { status: 400 });
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    console.error(JSON.stringify({ event: 'webhook_body_read_failed', request_id: requestId }));
    return Response.json({ error: 'Something went wrong' }, { status: 500 });
  }
  if (raw.length === 0 || raw.length > MAX_BODY_BYTES) {
    console.error(
      JSON.stringify({
        event: raw.length === 0 ? 'webhook_empty_body' : 'webhook_body_too_large',
        request_id: requestId,
      }),
    );
    return Response.json({ error: raw.length === 0 ? 'Bad request' : 'Payload too large' }, { status: raw.length === 0 ? 400 : 413 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    console.error(JSON.stringify({ event: 'webhook_malformed_json', request_id: requestId }));
    return Response.json({ error: 'Bad request' }, { status: 400 });
  }

  const update = parseTelegramUpdate(payload);
  if (update === null) {
    console.error(JSON.stringify({ event: 'webhook_invalid_update', request_id: requestId }));
    return Response.json({ error: 'Bad request' }, { status: 400 });
  }

  const db = env.DB;
  if (!db || typeof db.prepare !== 'function') {
    console.error(JSON.stringify({ event: 'webhook_missing_binding', request_id: requestId }));
    return Response.json({ error: 'Something went wrong' }, { status: 500 });
  }

  // Update kind for the durable idempotency ledger. Admin traffic (the /admin
  // command and admin callbacks) and control-plane commands (/start, /help)
  // are claimed under kind 'admin' so they never re-enter conversational
  // processing on redelivery.
  const isControlPlaneUpdate =
    update.kind === 'admin_callback' ||
    (update.kind === 'text_message' && (update.text.trim() === ADMIN_COMMAND || isControlPlaneCommand(update.text)));
  const kind = isControlPlaneUpdate ? 'admin' : update.kind === 'text_message' ? 'text' : 'unsupported';
  const updateUserId = update.kind === 'text_message' || update.kind === 'admin_callback' ? update.userId : null;
  let claimed: boolean;
  try {
    claimed = await claimUpdate(db, update.updateId, updateUserId, kind, now());
  } catch {
    console.error(JSON.stringify({ event: 'webhook_claim_failed', request_id: requestId }));
    return Response.json({ error: 'Something went wrong' }, { status: 500 });
  }
  if (!claimed) {
    // Duplicate delivery. With a conversational flow, a completed update may
    // still owe a delivery (previous send failed); reuse the durable result —
    // never regenerate. Without a flow (transport-only) just acknowledge.
    // Admin updates are fully handled on first delivery: duplicates are
    // acknowledged without re-executing any admin logic (idempotency).
    if (isControlPlaneUpdate) return Response.json({ ok: true });
    const botToken = env.TELEGRAM_BOT_TOKEN;
    if (deps.flow !== undefined && update.kind === 'text_message' && update.chatType === 'private' && typeof botToken === 'string' && botToken.length > 0) {
      try {
        const internalUserId = await findInternalUserIdByTelegramId(db, update.userId);
        if (internalUserId !== null) {
          const flowDeps = deps.flow(requestId, internalUserId);
          const text = await getCompletedAssistantText(update.updateId, flowDeps);
          if (text !== null) {
            await sendTelegramMessage({ token: botToken, chatId: update.chatId, text, fetchImpl: deps.fetchImpl });
            return Response.json({ ok: true });
          }
        }
      } catch {
        console.error(JSON.stringify({ event: 'webhook_redelivery_failed', request_id: requestId }));
        return Response.json({ error: 'Something went wrong' }, { status: 500 });
      }
    }
    return Response.json({ ok: true });
  }

  if (update.kind === 'unsupported') {
    return Response.json({ ok: true });
  }

  // Private-chat-only conversational processing (Phase 6, approved): group,
  // supergroup, channel, and unknown chat types never reach the pipeline —
  // no user upsert, no conversation resolution, no history, no AI, no persist.
  if (update.chatType !== 'private') {
    return Response.json({ ok: true });
  }

  // Phase 9 admin path: /admin and admin callbacks are handled here, AFTER the
  // private-chat gate and BEFORE any user upsert, conversation resolution, or
  // quota/admission accounting. Admin traffic never enters the conversational
  // flow, never invokes Agent Core / AI Router / tools, and never consumes
  // normal conversational quota. Without a wired AdminService the update is
  // acknowledged (fail closed) rather than treated as a chat message.
  //
  // Admin panel delivery (Phase 10 UX): one panel message per chat. Views EDIT
  // that message (editMessageText); Close DELETES it. A durable D1 session
  // (admin_panel_sessions) binds every callback to the panel's chat, message,
  // and owning admin, with a 5-minute inactivity expiry enforced by the
  // scheduled cleanup handler — not by in-isolate timers.
  if (isControlPlaneUpdate) {
    // Control-plane commands (/start, /help): deterministic, no AI required.
    if (update.kind === 'text_message' && isControlPlaneCommand(update.text)) {
      const cpBotToken = env.TELEGRAM_BOT_TOKEN;
      if (typeof cpBotToken !== 'string' || cpBotToken.length === 0) {
        console.error(JSON.stringify({ event: 'webhook_misconfigured', request_id: requestId }));
        return Response.json({ error: 'Something went wrong' }, { status: 500 });
      }
      try {
        await upsertTelegramUser(
          db,
          { telegramUserId: update.userId, username: update.username, displayName: update.displayName },
          now(),
          env.OWNER_TELEGRAM_ID,
        );
        const result = await handleControlPlaneCommand(db, update.userId, update.text);
        await sendTelegramMessage({
          token: cpBotToken,
          chatId: update.chatId,
          text: result.text,
          replyMarkup: result.keyboard ? { inline_keyboard: result.keyboard } : undefined,
          fetchImpl: deps.fetchImpl,
        });
        return Response.json({ ok: true });
      } catch {
        console.error(JSON.stringify({ event: 'command_handling_failed', request_id: requestId }));
        return Response.json({ error: 'Something went wrong' }, { status: 500 });
      }
    }
    const adminService = deps.adminService;
    if (adminService === undefined) return Response.json({ ok: true });
    const botToken = env.TELEGRAM_BOT_TOKEN;
    if (typeof botToken !== 'string' || botToken.length === 0) {
      console.error(JSON.stringify({ event: 'webhook_misconfigured', request_id: requestId }));
      return Response.json({ error: 'Something went wrong' }, { status: 500 });
    }
    const nowMs = Date.parse(now());
    try {
      if (update.kind === 'admin_callback') {
        const editCall = (input: EditCall): Promise<void> => editMessageText({ ...input, fetchImpl: deps.fetchImpl });
        const answerCall = (text?: string): Promise<unknown> =>
          answerCallbackQuery({ token: botToken, callbackQueryId: update.callbackQueryId, ...(text !== undefined ? { text } : {}), ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}) }).catch(() => undefined);
        const deleteCall = (messageId: number): Promise<void> =>
          deleteMessage({ token: botToken, chatId: update.chatId, messageId, ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}) });
        return await handleAdminPanelCallback({
          db, botToken, nowMs, chatId: update.chatId, telegramUserId: update.userId, messageId: update.messageId, data: update.data, requestId, adminService, editCall, answerCall, deleteCall,
        });
      }
      // /admin text command: open exactly one panel message per chat.
      const adminOutcome = await handleAdminCommand(db, adminService, update.userId);
      if (adminOutcome.kind === 'close') {
        // Unreachable: opening the menu never closes. Fail closed if it happens.
        return Response.json({ ok: true });
      }
      if (adminOutcome.kind !== 'view') {
        await sendTelegramMessage({ token: botToken, chatId: update.chatId, text: adminOutcome.text, fetchImpl: deps.fetchImpl });
        return Response.json({ ok: true });
      }
      const internalUserId = await findInternalUserIdByTelegramId(db, update.userId).catch(() => null);
      const editCall = (input: EditCall): Promise<void> => editMessageText({ ...input, fetchImpl: deps.fetchImpl });
      await openAdminPanel(db, botToken, nowMs, update.chatId, update.userId, internalUserId, adminOutcome, requestId, deps.fetchImpl, editCall);
      return Response.json({ ok: true });
    } catch {
      // Telegram send failures after authorization: keep the claim (at-least-
      // once delivery semantics, Phase 6) and fail the request so ops can see it.
      console.error(JSON.stringify({ event: 'webhook_admin_failed', request_id: requestId }));
      return Response.json({ error: 'Something went wrong' }, { status: 500 });
    }
  }

  // Background execution: the entire conversational path (user upsert →
  // internal-user resolution → memory/routing commands → Agent Core → AI
  // Router → persist → Telegram delivery) runs in this closure. When
  // deps.waitUntil is present (production), the webhook returns 200 right
  // after the durable claim, so Telegram's ~60s webhook deadline can never
  // cancel an in-flight provider generation. The durable state machine
  // (claimed → generating → completed | failed) is unchanged: markGenerating
  // remains the one-way gate that forbids regeneration on redelivery.
  const processConversationalFlow = async (): Promise<Response> => {
  try {
    await upsertTelegramUser(
      db,
      { telegramUserId: update.userId, username: update.username, displayName: update.displayName },
      now(),
      env.OWNER_TELEGRAM_ID,
    );
  } catch {
    console.error(JSON.stringify({ event: 'webhook_user_upsert_failed', request_id: requestId }));
    return Response.json({ error: 'Something went wrong' }, { status: 500 });
  }

  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (typeof botToken !== 'string' || botToken.length === 0) {
    // No AI has run in any mode at this point; release the claim so a
    // redelivery after configuration is repaired can process the update.
    await releaseUpdateClaim(db, update.updateId).catch(() => undefined);
    console.error(JSON.stringify({ event: 'webhook_misconfigured', request_id: requestId }));
    return Response.json({ error: 'Something went wrong' }, { status: 500 });
  }

  const flow = deps.flow;
  if (flow === undefined) {
    // Transport-only mode (Phase 2 semantics): send the acknowledgement and
    // release the claim on failure so redelivery reprocesses. No AI runs.
    try {
      await sendTelegramMessage({ token: botToken, chatId: update.chatId, text: TRANSPORT_ACK_TEXT, fetchImpl: deps.fetchImpl });
    } catch {
      await releaseUpdateClaim(db, update.updateId);
      console.error(JSON.stringify({ event: 'webhook_reply_failed', request_id: requestId }));
      return Response.json({ error: 'Something went wrong' }, { status: 500 });
    }
    return Response.json({ ok: true });
  }

  let assistantText: string;
  let flowErrorKind: ConversationFlowError['kind'] | null = null;
  try {
    const internalUserId = await findInternalUserIdByTelegramId(db, update.userId);
    if (internalUserId === null) {
      console.error(JSON.stringify({ event: 'webhook_user_missing', request_id: requestId }));
      throw new ConversationFlowError('conversation_failed');
    }
    // Phase 10 memory commands (/remember, /memories, /forget): intercepted
    // before the conversational flow so they never reach the AI path.
    // Fail-closed: when semantic memory infrastructure is unavailable, the
    // command returns a bounded "unavailable" message — no fallback to local.
    const memCmd = parseMemoryCommand(update.text);
    if (memCmd !== null) {
      const memService = buildProductionMemoryService(env);
      if (memService === null) {
        assistantText = 'Memory is currently unavailable.';
      } else {
        const result = await handleMemoryCommand(memCmd, internalUserId, memService);
        assistantText = result.text;
      }
    } else {
      // Phase 10 user routing commands (/fast, /smart, /research): explicit,
      // allowlisted profile selection parsed from the message prefix. The
      // stripped query is what the flow persists and sends to the model; the
      // command prefix never reaches history. Bare invocations (no query)
      // receive a bounded usage hint via the normal reply path — no separate
      // send, no quota bypass, same idempotency.
      const userCommand = parseUserCommand(update.text);
      const flowDeps = flow(requestId, internalUserId);
      if (userCommand !== null) {
        flowDeps.routingProfile = userCommand.profile;
        if (userCommand.query.length === 0) {
          assistantText = MODE_COMMAND_USAGE_HINT;
        } else {
          const result = await handleUserTextMessage(update.updateId, userCommand.query, flowDeps);
          if (result.decision === 'unavailable') throw new ConversationFlowError('conversation_failed');
          assistantText = result.assistantText;
        }
      } else {
        const result = await handleUserTextMessage(update.updateId, update.text, flowDeps);
        // Deterministic policy rejection (Phase 8): the admission ledger recorded
        // it durably, no AI ran, and the claim stays so Telegram redelivery of the
        // same update hits the durable decision without double-charging.
        // 'unavailable' is an infrastructure failure, not a policy decision:
        // treat it as pre-generation so the claim releases and redelivery retries.
        if (result.decision === 'unavailable') throw new ConversationFlowError('conversation_failed');
        assistantText = result.assistantText;
      }
    }
  } catch (error) {
    if (error instanceof ConversationFlowError) flowErrorKind = error.kind;
    // Pre-generation failures keep the claim releasable: no AI ran, so a
    // redelivery can safely reprocess from scratch. Post-generation failures
    // NEVER release — the durable state ('generating'/'failed'/'completed')
    // already forbids regeneration.
    if (flowErrorKind !== null && PRE_GENERATION_ERROR_KINDS.includes(flowErrorKind)) {
      await releaseUpdateClaim(db, update.updateId).catch(() => undefined);
    }
    const logEvent = 'webhook_flow_failed';
    // flowErrorKind is generic (e.g. 'agent_failed') and safe to log; it never
    // carries prompt/response content, credentials, or request bodies.
    console.error(JSON.stringify({ event: logEvent, kind: flowErrorKind, request_id: requestId }));
    return Response.json({ error: 'Something went wrong' }, { status: 500 });
  }

  try {
    await sendTelegramMessage({ token: botToken, chatId: update.chatId, text: assistantText, fetchImpl: deps.fetchImpl });
  } catch {
    // Delivery failed AFTER generation/persistence. Do NOT release the claim:
    // the assistant result is durable; redelivery reuses it for delivery
    // without invoking AI again.
    console.error(JSON.stringify({ event: 'webhook_reply_failed', request_id: requestId }));
    return Response.json({ error: 'Something went wrong' }, { status: 500 });
  }

  return Response.json({ ok: true });
  };

  if (deps.waitUntil !== undefined) {
    // Background mode: acknowledge Telegram immediately; conversational
    // processing (including AI generation and delivery) continues under
    // ExecutionContext.waitUntil and can no longer be canceled by Telegram's
    // webhook deadline. The catch-all logs with request_id only and releases
    // the claim — the release is SQL-guarded to processing_state = 'claimed',
    // so durable generating/completed/failed rows are never touched and
    // redelivery can never regenerate.
    deps.waitUntil(
      processConversationalFlow().catch(() => {
        console.error(JSON.stringify({ event: 'webhook_background_failed', request_id: requestId }));
        return releaseUpdateClaim(db, update.updateId).catch(() => undefined);
      }),
    );
    return Response.json({ ok: true });
  }
  // Synchronous fallback (no waitUntil supplied): legacy behavior, preserved
  // for tests and non-worker callers.
  return processConversationalFlow();
}
