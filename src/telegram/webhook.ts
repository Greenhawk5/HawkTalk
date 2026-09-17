import { claimUpdate, releaseUpdateClaim, upsertTelegramUser } from '../db/telegram';
import { findInternalUserIdByTelegramId } from '../db/users';
import type { ConversationFlowDeps } from '../orchestration/service';
import { ConversationFlowError, getCompletedAssistantText, handleUserTextMessage, PRE_GENERATION_ERROR_KINDS } from '../orchestration/service';
import type { AppEnv } from '../env';
import { sendTelegramMessage } from './client';
import { parseTelegramUpdate } from './parser';
import { TRANSPORT_ACK_TEXT } from './ack';

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

export interface WebhookDeps {
  fetchImpl?: typeof fetch | undefined;
  now?: (() => string) | undefined;
  /** Fully wired conversational dependencies; production composes D1 + AI Router. */
  flow?: ConversationFlowFactory | undefined;
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

  const kind = update.kind === 'text_message' ? 'text' : 'unsupported';
  const updateUserId = update.kind === 'text_message' ? update.userId : null;
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

  try {
    await upsertTelegramUser(
      db,
      { telegramUserId: update.userId, username: update.username, displayName: update.displayName },
      now(),
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

  if (deps.flow === undefined) {
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
  const flow = deps.flow;

  let assistantText: string;
  let flowErrorKind: ConversationFlowError['kind'] | null = null;
  try {
    const internalUserId = await findInternalUserIdByTelegramId(db, update.userId);
    if (internalUserId === null) {
      console.error(JSON.stringify({ event: 'webhook_user_missing', request_id: requestId }));
      throw new ConversationFlowError('conversation_failed');
    }
    const flowDeps = flow(requestId, internalUserId);
    const result = await handleUserTextMessage(update.updateId, update.text, flowDeps);
    // Deterministic policy rejection (Phase 8): the admission ledger recorded
    // it durably, no AI ran, and the claim stays so Telegram redelivery of the
    // same update hits the durable decision without double-charging.
    // 'unavailable' is an infrastructure failure, not a policy decision:
    // treat it as pre-generation so the claim releases and redelivery retries.
    if (result.decision === 'unavailable') throw new ConversationFlowError('conversation_failed');
    assistantText = result.assistantText;
  } catch (error) {
    if (error instanceof ConversationFlowError) flowErrorKind = error.kind;
    // Pre-generation failures keep the claim releasable: no AI ran, so a
    // redelivery can safely reprocess from scratch. Post-generation failures
    // NEVER release — the durable state ('generating'/'failed'/'completed')
    // already forbids regeneration.
    if (flowErrorKind !== null && PRE_GENERATION_ERROR_KINDS.includes(flowErrorKind)) {
      await releaseUpdateClaim(db, update.updateId).catch(() => undefined);
    }
    console.error(JSON.stringify({ event: 'webhook_flow_failed', request_id: requestId }));
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
}
