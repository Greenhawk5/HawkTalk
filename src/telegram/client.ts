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

/**
 * Telegram explicitly rejected a Bot API request (HTTP error status or
 * ok:false payload). Carries the sanitized status + Telegram description so
 * callers can classify PERMANENT rejections (e.g. "message to delete not
 * found") from transient ones. The description never contains the bot token
 * or request credentials; callers must still avoid logging raw payloads.
 */
export class TelegramApiRejection extends TelegramSendError {
  readonly httpStatus: number;
  readonly telegramDescription: string;
  constructor(httpStatus: number, telegramDescription: string) {
    super('Telegram API error');
    this.httpStatus = httpStatus;
    this.telegramDescription = telegramDescription;
  }
}

/** Extracts the bounded Telegram error description from an error response. */
async function telegramRejection(response: Response): Promise<TelegramApiRejection> {
  let description = '';
  try {
    const payload = (await response.json()) as { description?: unknown };
    if (typeof payload['description'] === 'string') description = payload['description'];
  } catch {
    // Description unavailable; classification falls back to the status code.
  }
  return new TelegramApiRejection(response.status, description);
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
  /** Telegram parse mode for formatted messages. Only 'HTML' is supported. */
  parseMode?: 'HTML' | undefined;
}

/** Telegram inline keyboard shape the admin UI is allowed to send. */
export interface TelegramInlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export interface SentMessage {
  /** Bot API message id of the sent message (panel session binding); null when absent. */
  messageId: number | null;
}

export async function sendTelegramMessage(options: SendTelegramMessageOptions): Promise<SentMessage> {
  const { token, chatId, timeoutMs = TELEGRAM_SEND_TIMEOUT_MS } = options;
  const fetchImpl: typeof fetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const text = options.text.length > MAX_MESSAGE_CHARS ? `${options.text.slice(0, MAX_MESSAGE_CHARS - 1)}…` : options.text;
  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (options.replyMarkup !== undefined) body['reply_markup'] = options.replyMarkup;
  if (options.parseMode !== undefined) body['parse_mode'] = options.parseMode;

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
      const result = (payload as { result?: unknown }).result;
      const messageId = typeof result === 'object' && result !== null && typeof (result as { message_id?: unknown }).message_id === 'number'
        ? (result as { message_id: number }).message_id
        : null;
      return { messageId };
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
  const { token, callbackQueryId, timeoutMs = TELEGRAM_SEND_TIMEOUT_MS } = options;
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
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

function isNetworkLike(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  return typeof error === 'object' && error !== null && 'name' in error && (error as { name: unknown }).name === 'AbortError';
}

export interface EditMessageTextOptions {
  token: string;
  chatId: number;
  messageId: number;
  text: string;
  replyMarkup?: TelegramInlineKeyboard | undefined;
  parseMode?: 'HTML' | undefined;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

/**
 * Edits an existing message in place (admin panel same-message navigation).
 * Single attempt, no retry: edits are not idempotent at the Bot API level and
 * the request may already have been processed. Telegram's benign
 * "message is not modified" rejection is treated as success so repeated
 * navigation callbacks (duplicate deliveries) stay idempotent.
 */
export async function editMessageText(options: EditMessageTextOptions): Promise<void> {
  const { token, chatId, messageId, timeoutMs = TELEGRAM_SEND_TIMEOUT_MS } = options;
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const text = options.text.length > MAX_MESSAGE_CHARS ? `${options.text.slice(0, MAX_MESSAGE_CHARS - 1)}…` : options.text;
  const url = `${TELEGRAM_API_BASE}/bot${token}/editMessageText`;
  const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text };
  if (options.replyMarkup !== undefined) body['reply_markup'] = options.replyMarkup;
  if (options.parseMode !== undefined) body['parse_mode'] = options.parseMode;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      // Telegram rejects a no-op edit with ok:false; that is success for us.
      let description = '';
      try {
        const payload = (await response.json()) as { description?: unknown };
        if (typeof payload['description'] === 'string') description = payload['description'];
      } catch {
        // fallthrough to generic failure
      }
      if (!description.includes('message is not modified')) throw new TelegramSendError('Telegram request failed');
      return;
    }
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      throw new TelegramSendError('Telegram response invalid');
    }
    if (!isApiResponse(payload) || payload.ok !== true) throw new TelegramSendError('Telegram API error');
  } catch (error) {
    if (isNetworkLike(error)) throw new TelegramSendError('Telegram request failed');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export interface DeleteMessageOptions {
  token: string;
  chatId: number;
  messageId: number;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

/**
 * Deletes a message (admin panel Close / expired panel cleanup). Single
 * attempt, no retry. Telegram's explicit "message to delete not found"
 * rejection surfaces as a TelegramApiRejection so callers can treat an
 * already-deleted message as success; network/timeout failures surface as a
 * plain TelegramSendError so callers can distinguish transient problems and
 * keep retryable state (the message may still exist).
 */
export async function deleteMessage(options: DeleteMessageOptions): Promise<void> {
  const { token, chatId, messageId, timeoutMs = TELEGRAM_SEND_TIMEOUT_MS } = options;
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const url = `${TELEGRAM_API_BASE}/bot${token}/deleteMessage`;
  const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw await telegramRejection(response);
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      throw new TelegramSendError('Telegram response invalid');
    }
    if (!isApiResponse(payload) || payload.ok !== true) {
      const description = typeof (payload as { description?: unknown })['description'] === 'string'
        ? ((payload as { description: string })['description'])
        : '';
      throw new TelegramApiRejection(response.status, description);
    }
  } catch (error) {
    if (isNetworkLike(error)) throw new TelegramSendError('Telegram request failed');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
