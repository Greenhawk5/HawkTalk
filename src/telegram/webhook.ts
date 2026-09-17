import { claimUpdate, releaseUpdateClaim, upsertTelegramUser } from '../db/telegram';
import type { AppEnv } from '../env';
import { sendTelegramMessage } from './client';
import { parseTelegramUpdate } from './parser';

// Telegram webhook entrypoint (Phase 2: transport only, no Agent Core).
//
// Pipeline:
//   POST + secret-token check -> bounded body read -> JSON parse ->
//   update_id validation -> atomic idempotency claim -> text messages get a
//   user upsert + placeholder reply; unsupported updates are acknowledged.
//
// Security properties:
// - Every failure mode returns a generic body; logs carry only {event,
//   request_id} plus non-sensitive counters. The bot token, webhook secret,
//   message text, and upstream error details never enter logs or responses.
// - Missing server-side secrets fail closed (500), never open.

export const TELEGRAM_WEBHOOK_PATH = '/telegram/webhook';
const WEBHOOK_SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token';
const MAX_BODY_BYTES = 256 * 1024;

// Phase 2 placeholder reply. It proves transport end-to-end without faking an
// AI response: the Agent Core does not exist yet (Phase 3).
export const TRANSPORT_ACK_TEXT =
  'HawkTalk received your message. Conversational replies arrive with the Agent Core (Phase 3).';

export interface WebhookDeps {
  fetchImpl?: typeof fetch | undefined;
  now?: (() => string) | undefined;
}

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
    return Response.json({ ok: true });
  }

  if (update.kind === 'unsupported') {
    return Response.json({ ok: true });
  }

  try {
    await upsertTelegramUser(
      db,
      { telegramUserId: update.userId, username: update.username, displayName: update.displayName },
      now(),
    );
  } catch {
    await releaseUpdateClaim(db, update.updateId);
    console.error(JSON.stringify({ event: 'webhook_user_upsert_failed', request_id: requestId }));
    return Response.json({ error: 'Something went wrong' }, { status: 500 });
  }

  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (typeof botToken !== 'string' || botToken.length === 0) {
    await releaseUpdateClaim(db, update.updateId);
    console.error(JSON.stringify({ event: 'webhook_misconfigured', request_id: requestId }));
    return Response.json({ error: 'Something went wrong' }, { status: 500 });
  }

  try {
    await sendTelegramMessage({
      token: botToken,
      chatId: update.chatId,
      text: TRANSPORT_ACK_TEXT,
      fetchImpl: deps.fetchImpl,
    });
  } catch {
    // Release the claim so a Telegram redelivery can reprocess; report 500 so
    // Telegram actually retries. The bounded client retry policy (network /
    // timeout only) keeps duplicate-send risk minimal.
    await releaseUpdateClaim(db, update.updateId);
    console.error(JSON.stringify({ event: 'webhook_reply_failed', request_id: requestId }));
    return Response.json({ error: 'Something went wrong' }, { status: 500 });
  }

  return Response.json({ ok: true });
}
