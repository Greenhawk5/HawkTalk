import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import worker from '../src';
import type { AppEnv } from '../src/env';
import { route } from '../src/router';
import { sendTelegramMessage, TELEGRAM_API_BASE, TelegramSendError } from '../src/telegram/client';
import { countProcessedUpdates, countUsersByTelegramId } from '../src/db/telegram';
import { parseTelegramUpdate } from '../src/telegram/parser';
import { timingSafeEqualString, TRANSPORT_ACK_TEXT } from '../src/telegram/webhook';

const URL_BASE = 'https://hawktalk.test';
const WEBHOOK_URL = `${URL_BASE}/telegram/webhook`;
const WEBHOOK_SECRET = 'test-webhook-secret-001';
const BOT_TOKEN = 'test-bot-token-001';
const FIXED_NOW = '2026-09-17T12:00:00.000Z';
const LATER_NOW = '2026-09-17T13:00:00.000Z';

// Single-signature fetch mock: avoids the overloaded global fetch type, while
// remaining assignable wherever `typeof fetch` is accepted.
type FetchMock = Mock<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeEnv(includeSecrets = true): Partial<AppEnv> {
  const out: Partial<AppEnv> = { APP_ENV: 'development', DB: env.DB };
  if (includeSecrets) {
    out.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
    out.TELEGRAM_WEBHOOK_SECRET = WEBHOOK_SECRET;
  }
  return out;
}

function telegramOk(): Response {
  return Response.json({ ok: true, result: { message_id: 9 } });
}

function webhookRequest(options: {
  body?: unknown;
  rawBody?: string;
  secret?: string | null;
  method?: string;
  contentType?: string | null;
} = {}): Request {
  const { secret = WEBHOOK_SECRET, method = 'POST', contentType = 'application/json' } = options;
  const headers = new Headers();
  if (secret !== null) headers.set('X-Telegram-Bot-Api-Secret-Token', secret);
  if (contentType !== null) headers.set('content-type', contentType);
  let body: string | undefined;
  if (options.rawBody !== undefined) body = options.rawBody;
  else if (options.body !== undefined) body = JSON.stringify(options.body);
  if (body === undefined) return new Request(WEBHOOK_URL, { method, headers });
  return new Request(WEBHOOK_URL, { method, headers, body });
}

function textUpdate(updateId: number, userId = 111, text = 'hello'): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: 1,
      from: { id: userId, is_bot: false, first_name: 'Ada', last_name: 'Lovelace', username: 'adalace' },
      chat: { id: 222, type: 'private' },
      date: 1726579200,
      text,
    },
  };
}

async function callWebhook(
  req: Request,
  opts: { telegramFetch?: FetchMock; now?: () => string; env?: Partial<AppEnv> } = {},
): Promise<{ response: Response; telegramFetch: FetchMock }> {
  const telegramFetch = opts.telegramFetch ?? vi.fn().mockResolvedValue(telegramOk());
  const response = await route(req, {
    env: opts.env ?? makeEnv(),
    requestId: 'test-request-id',
    telegramFetch,
    now: opts.now ?? (() => FIXED_NOW),
  });
  return { response, telegramFetch };
}

function firstCallBody(mock: FetchMock): { url: string; payload: Record<string, unknown> } {
  const call = mock.mock.calls[0];
  if (!call) throw new Error('expected fetch to be called');
  const body = call[1]?.body;
  if (body === undefined || body === null) throw new Error('expected a request body');
  return { url: String(call[0]), payload: JSON.parse(String(body)) as Record<string, unknown> };
}

async function readUser(telegramUserId: number): Promise<Record<string, unknown> | null> {
  return env.DB.prepare('SELECT * FROM users WHERE telegram_user_id = ?')
    .bind(telegramUserId)
    .first<Record<string, unknown>>();
}

// --- authentication -------------------------------------------------------

describe('webhook authentication', () => {
  it('accepts the correct secret token', async () => {
    const { response } = await callWebhook(webhookRequest({ body: textUpdate(1001) }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
  it('rejects a missing secret with a generic 401', async () => {
    const { response } = await callWebhook(webhookRequest({ body: textUpdate(1002), secret: null }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });
  it('rejects a wrong secret with the identical generic 401', async () => {
    const { response } = await callWebhook(webhookRequest({ body: textUpdate(1003), secret: 'wrong-secret' }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });
  it('rejects an empty secret', async () => {
    const { response } = await callWebhook(webhookRequest({ body: textUpdate(1004), secret: '' }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });
  it('fails closed when the server secret is not configured', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { response, telegramFetch } = await callWebhook(webhookRequest({ body: textUpdate(1005) }), { env: makeEnv(false) });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Something went wrong' });
    expect(telegramFetch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: 'webhook_misconfigured', request_id: 'test-request-id' }));
  });
  it('fails closed when the server secret is empty', async () => {
    const envir = makeEnv();
    envir.TELEGRAM_WEBHOOK_SECRET = '';
    const { response } = await callWebhook(webhookRequest({ body: textUpdate(1006) }), { env: envir });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Something went wrong' });
  });
  it('compares secrets in constant time', () => {
    expect(timingSafeEqualString('abc', 'abc')).toBe(true);
    expect(timingSafeEqualString('abc', 'abd')).toBe(false);
    expect(timingSafeEqualString('abc', 'abcd')).toBe(false);
    // Two empty strings are equal; the webhook still rejects empty presented
    // secrets because the configured server secret is never empty (fail-closed).
    expect(timingSafeEqualString('', '')).toBe(true);
    expect(timingSafeEqualString('', 'x')).toBe(false);
  });
});

// --- HTTP behavior --------------------------------------------------------

describe('webhook HTTP behavior', () => {
  it('rejects GET with 405 and Allow: POST', async () => {
    const { response } = await callWebhook(webhookRequest({ method: 'GET' }));
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
    expect(await response.json()).toEqual({ error: 'Method not allowed' });
  });
  it('rejects malformed JSON', async () => {
    const { response } = await callWebhook(webhookRequest({ rawBody: '{not json' }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Bad request' });
  });
  it('rejects a wrong content type', async () => {
    const { response } = await callWebhook(webhookRequest({ rawBody: '{}', contentType: 'text/plain' }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Bad request' });
  });
  it('rejects a missing content type', async () => {
    const { response } = await callWebhook(webhookRequest({ body: textUpdate(1010), contentType: null }));
    expect(response.status).toBe(400);
  });
  it('rejects an empty body', async () => {
    const req = new Request(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET },
    });
    const { response } = await callWebhook(req);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Bad request' });
  });
  it('rejects an oversized body with 413', async () => {
    const big = `{"update_id":1012,"pad":"${'x'.repeat(300 * 1024)}"}`;
    const { response } = await callWebhook(webhookRequest({ rawBody: big }));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'Payload too large' });
  });
  it('fails closed without an environment', async () => {
    const response = await route(webhookRequest({ body: textUpdate(1013) }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Something went wrong' });
  });
});

// --- update validation ----------------------------------------------------

describe('update validation', () => {
  it.each([{}, { update_id: '5' }, { update_id: 1.5 }, { update_id: -1 }, [], 'text', 42, null])(
    'rejects invalid payload %j with 400',
    async (body) => {
      const { response } = await callWebhook(webhookRequest({ body: body as unknown }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Bad request' });
    },
  );
  it('acknowledges an update with no message without sending', async () => {
    const { response, telegramFetch } = await callWebhook(webhookRequest({ body: { update_id: 1020 } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(telegramFetch).not.toHaveBeenCalled();
    expect(await countProcessedUpdates(env.DB, 1020)).toBe(1);
  });
  it('acknowledges edited_message updates without sending', async () => {
    const body = {
      update_id: 1021,
      edited_message: { message_id: 2, from: { id: 111 }, chat: { id: 222 }, text: 'edited' },
    };
    const { response, telegramFetch } = await callWebhook(webhookRequest({ body }));
    expect(response.status).toBe(200);
    expect(telegramFetch).not.toHaveBeenCalled();
  });
  it('acknowledges non-text messages without creating a user', async () => {
    const body = {
      update_id: 1022,
      message: {
        message_id: 3,
        from: { id: 333, first_name: 'Photo' },
        chat: { id: 444 },
        photo: [{ file_id: 'abc' }],
      },
    };
    const { response, telegramFetch } = await callWebhook(webhookRequest({ body }));
    expect(response.status).toBe(200);
    expect(telegramFetch).not.toHaveBeenCalled();
    expect(await countUsersByTelegramId(env.DB, 333)).toBe(0);
  });
  it('acknowledges messages without a sender', async () => {
    const body = { update_id: 1023, message: { message_id: 4, chat: { id: 555 }, text: 'orphan' } };
    const { response, telegramFetch } = await callWebhook(webhookRequest({ body }));
    expect(response.status).toBe(200);
    expect(telegramFetch).not.toHaveBeenCalled();
  });
  it('acknowledges messages without a chat', async () => {
    const body = { update_id: 1024, message: { message_id: 5, from: { id: 666 }, text: 'no chat' } };
    const { response, telegramFetch } = await callWebhook(webhookRequest({ body }));
    expect(response.status).toBe(200);
    expect(telegramFetch).not.toHaveBeenCalled();
    expect(await countUsersByTelegramId(env.DB, 666)).toBe(0);
  });
  it('parses parser edge cases directly', () => {
    expect(parseTelegramUpdate({ update_id: 1, message: null })).toEqual({ kind: 'unsupported', updateId: 1 });
    expect(parseTelegramUpdate({ update_id: 2 })).toEqual({ kind: 'unsupported', updateId: 2 });
    expect(parseTelegramUpdate(null)).toBeNull();
    expect(
      parseTelegramUpdate({ update_id: 3, message: { from: { id: 7 }, chat: { id: 8 }, text: 'x' } }),
    ).toEqual({ kind: 'text_message', updateId: 3, userId: 7, chatId: 8, text: 'x', username: null, displayName: null });
  });
});

// --- identity -------------------------------------------------------------

describe('user identity', () => {
  it('creates a user row on first contact', async () => {
    const { response, telegramFetch } = await callWebhook(webhookRequest({ body: textUpdate(1030, 9001) }));
    expect(response.status).toBe(200);
    expect(telegramFetch).toHaveBeenCalledTimes(1);
    const row = await readUser(9001);
    expect(row).toMatchObject({ telegram_user_id: 9001, username: 'adalace', display_name: 'Ada Lovelace', status: 'active' });
    expect(row?.['created_at']).toBe(FIXED_NOW);
    expect(row?.['last_seen']).toBe(FIXED_NOW);
  });
  it('reuses the row and refreshes mutable profile fields', async () => {
    await callWebhook(webhookRequest({ body: textUpdate(1031, 9002) }));
    const renamed = textUpdate(1032, 9002);
    const message = renamed['message'] as Record<string, unknown>;
    message['from'] = { id: 9002, first_name: 'Ada', username: 'newhandle' };
    await callWebhook(webhookRequest({ body: renamed }), { now: () => LATER_NOW });
    const rows = await env.DB.prepare('SELECT * FROM users WHERE telegram_user_id = ?').bind(9002).all();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({ username: 'newhandle', display_name: 'Ada', last_seen: LATER_NOW });
  });
  it('stores nulls when username and last name are absent', async () => {
    const body = textUpdate(1033, 9003);
    const message = body['message'] as Record<string, unknown>;
    message['from'] = { id: 9003, first_name: 'Solo' };
    await callWebhook(webhookRequest({ body }));
    expect(await readUser(9003)).toMatchObject({ username: null, display_name: 'Solo' });
  });
  it('keeps users isolated by numeric ID', async () => {
    await callWebhook(webhookRequest({ body: textUpdate(1034, 9101) }));
    await callWebhook(webhookRequest({ body: textUpdate(1035, 9102) }));
    expect(await countUsersByTelegramId(env.DB, 9101)).toBe(1);
    expect(await countUsersByTelegramId(env.DB, 9102)).toBe(1);
    const other = await readUser(9101);
    expect(other?.['telegram_user_id']).toBe(9101);
  });
  it('sends the transport acknowledgement, not a fake AI reply', async () => {
    const telegramFetch = vi.fn().mockResolvedValue(telegramOk());
    await callWebhook(webhookRequest({ body: textUpdate(1036, 9200) }), { telegramFetch });
    const { url, payload } = firstCallBody(telegramFetch);
    expect(url).toBe(`${TELEGRAM_API_BASE}/bot${BOT_TOKEN}/sendMessage`);
    expect(payload['chat_id']).toBe(222);
    expect(payload['text']).toBe(TRANSPORT_ACK_TEXT);
  });
});

// --- idempotency ----------------------------------------------------------

describe('duplicate update protection', () => {
  it('processes a repeated update exactly once', async () => {
    const telegramFetch = vi.fn().mockResolvedValue(telegramOk());
    const first = await callWebhook(webhookRequest({ body: textUpdate(1040, 9301) }), { telegramFetch });
    const second = await callWebhook(webhookRequest({ body: textUpdate(1040, 9301) }), { telegramFetch });
    expect(await first.response.json()).toEqual({ ok: true });
    expect(await second.response.json()).toEqual({ ok: true });
    expect(telegramFetch).toHaveBeenCalledTimes(1);
    expect(await countProcessedUpdates(env.DB, 1040)).toBe(1);
    expect(await countUsersByTelegramId(env.DB, 9301)).toBe(1);
  });
  it('survives concurrent duplicate deliveries with a single send', async () => {
    const telegramFetch = vi.fn().mockResolvedValue(telegramOk());
    const results = await Promise.all(
      Array.from({ length: 5 }, () => callWebhook(webhookRequest({ body: textUpdate(1041, 9302) }), { telegramFetch })),
    );
    for (const { response } of results) expect(response.status).toBe(200);
    expect(telegramFetch).toHaveBeenCalledTimes(1);
    expect(await countProcessedUpdates(env.DB, 1041)).toBe(1);
  });
  it('processes distinct updates independently', async () => {
    const telegramFetch = vi.fn().mockResolvedValue(telegramOk());
    await callWebhook(webhookRequest({ body: textUpdate(1042, 9303) }), { telegramFetch });
    await callWebhook(webhookRequest({ body: textUpdate(1043, 9303) }), { telegramFetch });
    expect(telegramFetch).toHaveBeenCalledTimes(2);
  });
  it('releases the claim on reply failure so redelivery can reprocess', async () => {
    const telegramFetch = vi.fn().mockRejectedValue(new TypeError('network down'));
    const failing = await callWebhook(webhookRequest({ body: textUpdate(1044, 9304) }), { telegramFetch });
    expect(failing.response.status).toBe(500);
    expect(await failing.response.json()).toEqual({ error: 'Something went wrong' });
    // Bounded retry: exactly two send attempts, then the claim is released.
    expect(telegramFetch).toHaveBeenCalledTimes(2);
    expect(await countProcessedUpdates(env.DB, 1044)).toBe(0);

    telegramFetch.mockResolvedValue(telegramOk());
    const retry = await callWebhook(webhookRequest({ body: textUpdate(1044, 9304) }), { telegramFetch });
    expect(retry.response.status).toBe(200);
    expect(await countProcessedUpdates(env.DB, 1044)).toBe(1);
    expect(await countUsersByTelegramId(env.DB, 9304)).toBe(1);
  });
  it('returns 500 without leaking when the bot token is missing', async () => {
    const envir = makeEnv();
    delete envir.TELEGRAM_BOT_TOKEN;
    const telegramFetch = vi.fn();
    const { response } = await callWebhook(webhookRequest({ body: textUpdate(1045, 9305) }), { env: envir, telegramFetch });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Something went wrong' });
    expect(telegramFetch).not.toHaveBeenCalled();
    expect(await countProcessedUpdates(env.DB, 1045)).toBe(0);
  });
});

// --- Telegram API client --------------------------------------------------

describe('Telegram client', () => {
  it('posts to sendMessage with JSON body', async () => {
    const telegramFetch = vi.fn().mockResolvedValue(telegramOk());
    await sendTelegramMessage({ token: BOT_TOKEN, chatId: 222, text: 'hi', fetchImpl: telegramFetch });
    expect(telegramFetch).toHaveBeenCalledTimes(1);
    const call = telegramFetch.mock.calls[0];
    if (!call) throw new Error('expected fetch to be called');
    expect(String(call[0])).toBe(`${TELEGRAM_API_BASE}/bot${BOT_TOKEN}/sendMessage`);
    expect(call[1]?.method).toBe('POST');
    expect(call[1]?.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(String(call[1]?.body)) as unknown).toEqual({ chat_id: 222, text: 'hi' });
  });
  it('does not retry HTTP error statuses', async () => {
    const telegramFetch = vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 }));
    await expect(sendTelegramMessage({ token: BOT_TOKEN, chatId: 1, text: 'hi', fetchImpl: telegramFetch })).rejects.toThrow(
      TelegramSendError,
    );
    expect(telegramFetch).toHaveBeenCalledTimes(1);
  });
  it('does not retry ok:false payloads', async () => {
    const telegramFetch = vi.fn().mockResolvedValue(Response.json({ ok: false, description: 'chat not found' }));
    await expect(sendTelegramMessage({ token: BOT_TOKEN, chatId: 1, text: 'hi', fetchImpl: telegramFetch })).rejects.toThrow(
      'Telegram API error',
    );
    expect(telegramFetch).toHaveBeenCalledTimes(1);
  });
  it('does not retry malformed responses', async () => {
    const telegramFetch = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }));
    await expect(sendTelegramMessage({ token: BOT_TOKEN, chatId: 1, text: 'hi', fetchImpl: telegramFetch })).rejects.toThrow(
      'Telegram response invalid',
    );
    expect(telegramFetch).toHaveBeenCalledTimes(1);
  });
  it('retries a network failure once, then fails', async () => {
    const telegramFetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(sendTelegramMessage({ token: BOT_TOKEN, chatId: 1, text: 'hi', fetchImpl: telegramFetch })).rejects.toThrow(
      'Telegram request failed',
    );
    expect(telegramFetch).toHaveBeenCalledTimes(2);
  });
  it('recovers when the retry succeeds', async () => {
    const telegramFetch = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(telegramOk());
    await sendTelegramMessage({ token: BOT_TOKEN, chatId: 1, text: 'hi', fetchImpl: telegramFetch });
    expect(telegramFetch).toHaveBeenCalledTimes(2);
  });
  it('bounds total attempts on timeouts', async () => {
    const hanging = vi.fn().mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    await expect(
      sendTelegramMessage({ token: BOT_TOKEN, chatId: 1, text: 'hi', fetchImpl: hanging, timeoutMs: 5 }),
    ).rejects.toThrow('Telegram request failed');
    expect(hanging).toHaveBeenCalledTimes(2);
  });
  it('truncates overlong messages to the Telegram limit', async () => {
    const telegramFetch = vi.fn().mockResolvedValue(telegramOk());
    await sendTelegramMessage({ token: BOT_TOKEN, chatId: 1, text: 'x'.repeat(5000), fetchImpl: telegramFetch });
    const { payload } = firstCallBody(telegramFetch);
    expect(typeof payload['text']).toBe('string');
    expect((payload['text'] as string).length).toBeLessThanOrEqual(4096);
  });
  it('never embeds the token in thrown errors', async () => {
    const telegramFetch = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }));
    try {
      await sendTelegramMessage({ token: BOT_TOKEN, chatId: 1, text: 'hi', fetchImpl: telegramFetch });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(BOT_TOKEN);
      expect((error as Error).message).not.toContain(BOT_TOKEN);
    }
  });
});

// --- security -------------------------------------------------------------

describe('webhook security', () => {
  it('never exposes the bot token or webhook secret in responses', async () => {
    const bodies: string[] = [];
    const scenarios: Array<() => Promise<Response>> = [
      async () => (await callWebhook(webhookRequest({ body: textUpdate(1050, 9401) }))).response,
      async () => (await callWebhook(webhookRequest({ body: textUpdate(1051), secret: 'wrong' }))).response,
      async () => (await callWebhook(webhookRequest({ rawBody: '{bad' }))).response,
      async () => {
        const failing = vi.fn().mockResolvedValue(new Response('err', { status: 500 }));
        return (await callWebhook(webhookRequest({ body: textUpdate(1052, 9402) }), { telegramFetch: failing })).response;
      },
    ];
    for (const run of scenarios) bodies.push(await (await run()).text());
    for (const body of bodies) {
      expect(body).not.toContain(BOT_TOKEN);
      expect(body).not.toContain(WEBHOOK_SECRET);
    }
  });
  it('never logs secrets or message content', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const marker = 'PRIVATE-CONTENT-marker-7f3a';
    await callWebhook(webhookRequest({ body: textUpdate(1053, 9403, marker) }));
    await callWebhook(webhookRequest({ body: textUpdate(1054), secret: 'wrong' }));
    const logged = log.mock.calls.map((args) => String(args[0])).join('\n');
    expect(logged).not.toContain(BOT_TOKEN);
    expect(logged).not.toContain(WEBHOOK_SECRET);
    expect(logged).not.toContain(marker);
    for (const args of log.mock.calls) {
      const parsed = JSON.parse(String(args[0])) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual(['event', 'request_id']);
    }
  });
  it('stores hostile usernames literally without breaking the schema', async () => {
    const hostile = `' OR '1'='1'; DROP TABLE users; --`;
    const body = textUpdate(1055, 9404);
    const message = body['message'] as Record<string, unknown>;
    message['from'] = { id: 9404, first_name: 'Eve', username: hostile };
    const { response } = await callWebhook(webhookRequest({ body }));
    expect(response.status).toBe(200);
    expect(await readUser(9404)).toMatchObject({ username: hostile });
    const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'users'").first();
    expect(tables).not.toBeNull();
  });
  it('one user cannot create or alter another user row', async () => {
    await callWebhook(webhookRequest({ body: textUpdate(1056, 9405) }));
    const before = await readUser(9405);
    await callWebhook(webhookRequest({ body: textUpdate(1057, 9406) }));
    expect(await readUser(9405)).toEqual(before);
    expect(await countUsersByTelegramId(env.DB, 9406)).toBe(1);
  });
});

// --- entrypoint wiring ----------------------------------------------------

describe('webhook entrypoint wiring', () => {
  it('serves the webhook through the Worker with hardened headers', async () => {
    const telegramFetch = vi.fn().mockResolvedValue(telegramOk());
    vi.stubGlobal('fetch', telegramFetch);
    try {
      const response = await worker.fetch(webhookRequest({ body: textUpdate(1060, 9501) }), makeEnv());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('X-Request-ID')).toMatch(/^[0-9a-f-]{36}$/);
      expect(telegramFetch).toHaveBeenCalledTimes(1);
      const call = telegramFetch.mock.calls[0];
      if (!call) throw new Error('expected fetch to be called');
      // The token in the outbound Bot API path is Telegram's required design;
      // the guarantee is that it never appears in logs, errors, or responses.
      expect(String(call[0])).toBe(`${TELEGRAM_API_BASE}/bot${BOT_TOKEN}/sendMessage`);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('correlates the unauthorized log with the response request ID', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await worker.fetch(webhookRequest({ body: textUpdate(1061), secret: 'wrong' }), makeEnv());
    expect(response.status).toBe(401);
    const requestId = response.headers.get('X-Request-ID');
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: 'webhook_unauthorized', request_id: requestId }));
  });
  it('keeps unknown routes at 404', async () => {
    const response = await route(new Request(`${URL_BASE}/nope`), { env: makeEnv(), requestId: 'test-request-id' });
    expect(response.status).toBe(404);
  });
});
