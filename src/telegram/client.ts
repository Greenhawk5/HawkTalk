import type { TelegramApiResponse } from './types';

// Isolated Telegram Bot API client (Phase 2: sendMessage only).
// Rules enforced here:
// - The bot token travels only in the request URL/body target; it is never
//   logged, never included in errors, and never reflected in responses.
// - Retries are bounded AND narrow: only network failures / timeouts (where the
//   request likely never reached Telegram) are retried, at most once. HTTP
//   error statuses, ok:false payloads, and malformed responses are never
//   retried, because the request may already have been processed server-side
//   and retrying could deliver a duplicate message.

export const TELEGRAM_API_BASE = 'https://api.telegram.org';
export const TELEGRAM_SEND_TIMEOUT_MS = 10_000;
const MAX_SEND_ATTEMPTS = 2;
const MAX_MESSAGE_CHARS = 4096;

export class TelegramSendError extends Error {
  constructor(message: 'Telegram request failed' | 'Telegram API error' | 'Telegram response invalid') {
    super(message);
  }
}

function isRetryableFailure(error: unknown): boolean {
  // Network-level failures surface as TypeError in fetch; timeouts surface as
  // AbortError (a DOMException, not a TypeError). Anything else is a bug, not retryable.
  if (error instanceof TypeError) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name: unknown }).name === 'AbortError'
  );
}

function isApiResponse(value: unknown): value is TelegramApiResponse {
  return typeof value === 'object' && value !== null && 'ok' in value && typeof (value as { ok: unknown }).ok === 'boolean';
}

export interface SendTelegramMessageOptions {
  token: string;
  chatId: number;
  text: string;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  /** Optional bounded inline keyboard (Phase 9 admin UI). */
  replyMarkup?: TelegramInlineKeyboard | undefined;
}

/** Telegram inline keyboard shape the admin UI is allowed to send. */
export interface TelegramInlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export async function sendTelegramMessage(options: SendTelegramMessageOptions): Promise<void> {
  const { token, chatId, fetchImpl = globalThis.fetch, timeoutMs = TELEGRAM_SEND_TIMEOUT_MS } = options;
  const text = options.text.length > MAX_MESSAGE_CHARS ? `${options.text.slice(0, MAX_MESSAGE_CHARS - 1)}…` : options.text;
  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (options.replyMarkup !== undefined) body['reply_markup'] = options.replyMarkup;

  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new TelegramSendError('Telegram request failed');
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        throw new TelegramSendError('Telegram response invalid');
      }
      if (!isApiResponse(payload) || payload.ok !== true) throw new TelegramSendError('Telegram API error');
      clearTimeout(timer);
      return;
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof TelegramSendError) throw error;
      if (attempt >= MAX_SEND_ATTEMPTS || !isRetryableFailure(error)) {
        throw new TelegramSendError('Telegram request failed');
      }
    }
  }
  throw new TelegramSendError('Telegram request failed');
}

export interface AnswerCallbackQueryOptions {
  token: string;
  callbackQueryId: string;
  /** Bounded user-facing answer text; omitted answers just clear the spinner. */
  text?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

/**
 * Answers a callback query (Phase 9). Single attempt, no retry: the answer is
 * a UI courtesy, and duplicate Bot API answers are rejected by Telegram. The
 * text never contains secrets or internal error details.
 */
export async function answerCallbackQuery(options: AnswerCallbackQueryOptions): Promise<void> {
  const { token, callbackQueryId, fetchImpl = globalThis.fetch, timeoutMs = TELEGRAM_SEND_TIMEOUT_MS } = options;
  const url = `${TELEGRAM_API_BASE}/bot${token}/answerCallbackQuery`;
  const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
  if (typeof options.text === 'string' && options.text.length > 0) {
    body['text'] = options.text.length > 200 ? options.text.slice(0, 199) + '…' : options.text;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new TelegramSendError('Telegram request failed');
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      throw new TelegramSendError('Telegram response invalid');
    }
    if (!isApiResponse(payload) || payload.ok !== true) throw new TelegramSendError('Telegram API error');
  } finally {
    clearTimeout(timer);
  }
}
