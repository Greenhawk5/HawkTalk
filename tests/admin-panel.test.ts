// Admin panel session overhaul (Telegram UX): same-message navigation,
// ownership binding, 5-minute inactivity expiry, cron cleanup, and Close.
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { route } from '../src/router';
import { AdminService } from '../src/admin/service';
import type { AppEnv } from '../src/env';
import { cleanupExpiredPanels } from '../src/telegram/panel-cleanup';

const URL_BASE = 'https://hawktalk.test';
const WEBHOOK_URL = `${URL_BASE}/telegram/webhook`;
const WEBHOOK_SECRET = 'test-webhook-secret-panel';
const BOT_TOKEN = 'test-bot-token-panel';
const FIXED_NOW = '2026-09-21T12:00:00.000Z';
const PANEL_MESSAGE_ID = 9;

type FetchMock = Mock<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;

function makeEnv(): Partial<AppEnv> {
  return { APP_ENV: 'development', DB: env.DB, TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET };
}

function okJson(): Response {
  return Response.json({ ok: true, result: { message_id: PANEL_MESSAGE_ID } });
}

function okJsonWith(messageId: number): Response {
  return Response.json({ ok: true, result: { message_id: messageId } });
}

function textRequest(updateId: number, userId: number, text: string): Request {
  return new Request(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET },
    body: JSON.stringify({
      update_id: updateId,
      message: { message_id: 1, from: { id: userId, is_bot: false, first_name: 'A' }, chat: { id: userId, type: 'private' }, date: 1726579200, text },
    }),
  });
}

function callbackRequest(updateId: number, userId: number, data: string, messageId = PANEL_MESSAGE_ID): Request {
  return new Request(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET },
    body: JSON.stringify({
      update_id: updateId,
      callback_query: { id: `cbq${updateId}`, from: { id: userId, is_bot: false, first_name: 'A' }, message: { message_id: messageId, chat: { id: userId, type: 'private' } }, data },
    }),
  });
}

async function callWebhook(req: Request, opts: { telegramFetch?: FetchMock; now?: () => string; adminService?: AdminService; db?: D1Database } = {}): Promise<{ response: Response; telegramFetch: FetchMock }> {
  const telegramFetch = opts.telegramFetch ?? vi.fn().mockImplementation(() => okJson());
  const response = await route(req, {
    env: { ...makeEnv(), DB: opts.db ?? env.DB },
    requestId: 'panel-test-request-id',
    telegramFetch,
    now: opts.now ?? (() => FIXED_NOW),
    adminService: opts.adminService ?? new AdminService(env.DB, () => FIXED_NOW),
  });
  return { response, telegramFetch };
}

/**
 * Reproduces the EXACT production mismatch: a D1 where the
 * admin_panel_sessions table does not exist (migration 0011 missing). Every
 * panel-session statement throws "no such table"; all other statements pass
 * through to the real database.
 */
function dbWithoutPanelTable(base: D1Database): D1Database {
  return new Proxy(base, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          if (sql.includes('admin_panel_sessions')) {
            throw new Error('no such table: admin_panel_sessions');
          }
          return target.prepare(sql);
        };
      }
      return Reflect.get(target, prop, target);
    },
  }) as unknown as D1Database;
}

function callsByEndpoint(mock: FetchMock): Map<string, Array<Record<string, unknown>>> {
  const out = new Map<string, Array<Record<string, unknown>>>();
  for (const call of mock.mock.calls) {
    const url = String(call[0]);
    const endpoint = url.replace(/^.*bot[^/]+\//, '');
    const body = call[1]?.body === undefined || call[1]?.body === null ? {} : (JSON.parse(String(call[1]?.body)) as Record<string, unknown>);
    const list = out.get(endpoint) ?? [];
    list.push(body);
    out.set(endpoint, list);
  }
  return out;
}

async function seedUser(telegramId: number, role: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO users (telegram_user_id, username, display_name, status, role, created_at, updated_at, last_seen) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)",
  ).bind(telegramId, `u${telegramId}`, `User ${telegramId}`, role, FIXED_NOW, FIXED_NOW, FIXED_NOW).run();
}

async function sessionRow(chatId: number): Promise<Record<string, unknown> | null> {
  return env.DB.prepare('SELECT * FROM admin_panel_sessions WHERE chat_id = ?').bind(chatId).first<Record<string, unknown>>();
}

describe('admin panel sessions (same-message editing + expiry)', () => {
  it('/admin creates exactly one panel message and a bound durable session', async () => {
    await seedUser(8101, 'ADMIN');
    const { telegramFetch } = await callWebhook(textRequest(8100, 8101, '/admin'));
    const calls = callsByEndpoint(telegramFetch);
    expect(calls.get('sendMessage')?.length).toBe(1);
    const row = await sessionRow(8101);
    expect(row).not.toBeNull();
    expect(row?.['message_id']).toBe(PANEL_MESSAGE_ID);
    expect(row?.['telegram_user_id']).toBe(8101);
  });

  it('dashboard, users, providers, and menu navigation all EDIT the same message', async () => {
    await seedUser(8102, 'ADMIN');
    const adminService = new AdminService(env.DB, () => FIXED_NOW);
    await callWebhook(textRequest(8110, 8102, '/admin'), { adminService });
    for (const [i, data] of ['a:dashboard', 'a:users', 'a:providers', 'a:menu', 'a:users'].entries()) {
      const { telegramFetch } = await callWebhook(callbackRequest(8111 + i, 8102, data), { adminService });
      const calls = callsByEndpoint(telegramFetch);
      expect(calls.get('sendMessage')).toBeUndefined();
      expect(calls.get('editMessageText')?.length).toBe(1);
      expect(calls.get('answerCallbackQuery')?.length).toBe(1);
    }
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_panel_sessions').first('n')).toBe(1);
  });

  it('Close deletes the panel message and cleans up the session', async () => {
    await seedUser(8103, 'ADMIN');
    const adminService = new AdminService(env.DB, () => FIXED_NOW);
    await callWebhook(textRequest(8120, 8103, '/admin'), { adminService });
    const { telegramFetch } = await callWebhook(callbackRequest(8121, 8103, 'a:close'), { adminService });
    const calls = callsByEndpoint(telegramFetch);
    expect(calls.get('deleteMessage')).toEqual([{ chat_id: 8103, message_id: PANEL_MESSAGE_ID }]);
    expect(await sessionRow(8103)).toBeNull();
    expect(calls.get('sendMessage')).toBeUndefined();
  });

  it('expired panel callbacks are rejected safely and clean up the stale message', async () => {
    await seedUser(8104, 'ADMIN');
    const adminService = new AdminService(env.DB, () => FIXED_NOW);
    const later = new Date(Date.parse(FIXED_NOW) + 10 * 60 * 1000).toISOString();
    await callWebhook(textRequest(8130, 8104, '/admin'), { adminService });
    const { telegramFetch } = await callWebhook(callbackRequest(8131, 8104, 'a:dashboard'), { adminService, now: () => later });
    const calls = callsByEndpoint(telegramFetch);
    expect(calls.get('editMessageText')).toBeUndefined();
    expect(calls.get('deleteMessage')?.length).toBe(1);
    expect(JSON.stringify(calls.get('answerCallbackQuery') ?? [])).toContain('closed');
    expect(await sessionRow(8104)).toBeNull();
  });

  it('a fresh panel is immediately interactive and NOT expired (expires_at = now + 5 minutes)', async () => {
    await seedUser(8110, 'ADMIN');
    const adminService = new AdminService(env.DB, () => FIXED_NOW);
    await callWebhook(textRequest(8155, 8110, '/admin'), { adminService });
    const row = await sessionRow(8110);
    expect(row).not.toBeNull();
    expect(String(row?.['last_activity_at'])).toBe(FIXED_NOW);
    expect(String(row?.['expires_at'])).toBe(new Date(Date.parse(FIXED_NOW) + 5 * 60 * 1000).toISOString());
    // A callback issued immediately (same clock) must succeed: the fresh panel
    // is interactive, no "expired"/"closed" toast, and the message is edited.
    const { telegramFetch } = await callWebhook(callbackRequest(8156, 8110, 'a:dashboard'), { adminService });
    const calls = callsByEndpoint(telegramFetch);
    expect(calls.get('editMessageText')?.length).toBe(1);
    expect(JSON.stringify(calls.get('answerCallbackQuery') ?? [])).not.toContain('closed');
    expect(JSON.stringify(calls.get('answerCallbackQuery') ?? [])).not.toContain('expired');
  });

  it('REGRESSION (production): missing admin_panel_sessions table fails LOUDLY and never shows a fake "expired" panel', async () => {
    await seedUser(8114, 'ADMIN');
    const adminService = new AdminService(env.DB, () => FIXED_NOW);
    const broken = dbWithoutPanelTable(env.DB);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // /admin with a broken session store: the panel is sent, but the persist
    // failure MUST be visible in the logs (previously silently swallowed).
    await callWebhook(textRequest(8185, 8114, '/admin'), { adminService, db: broken });
    const logged = [...logSpy.mock.calls, ...errSpy.mock.calls].map((c) => String(c[0])).join('\n');
    expect(logged).toContain('admin_panel_session_read_failed');
    expect(logged).toContain('admin_panel_session_persist_failed');
    logSpy.mockRestore();
    errSpy.mockRestore();
    // A button press: the session lookup failure is infrastructure, NOT expiry.
    // It must answer "unavailable" — never "expired" — and run NO admin action.
    const { telegramFetch } = await callWebhook(callbackRequest(8186, 8114, 'a:dashboard'), { adminService, db: broken });
    const calls = callsByEndpoint(telegramFetch);
    expect(calls.get('editMessageText')).toBeUndefined();
    const answers = JSON.stringify(calls.get('answerCallbackQuery') ?? []);
    expect(answers).toContain('unavailable');
    expect(answers).not.toContain('expired');
    expect(await sessionRow(8114)).toBeNull();
  });

  it('REGRESSION (production): /admin twice reuses message 350 and never creates a second panel message', async () => {
    await seedUser(8115, 'ADMIN');
    const adminService = new AdminService(env.DB, () => FIXED_NOW);
    let nextId = 350;
    const telegramFetch: FetchMock = vi.fn().mockImplementation((input: string | URL | Request) => {
      if (String(input).includes('sendMessage')) return Promise.resolve(okJsonWith(nextId++));
      return Promise.resolve(okJson());
    });
    await callWebhook(textRequest(8190, 8115, '/admin'), { adminService, telegramFetch });
    const created = await sessionRow(8115);
    expect(created?.['message_id']).toBe(350);
    expect(String(created?.['expires_at'])).toBe(new Date(Date.parse(FIXED_NOW) + 5 * 60 * 1000).toISOString());
    // Immediate second /admin: MUST reuse message 350 (edit), never send 352.
    await callWebhook(textRequest(8191, 8115, '/admin'), { adminService, telegramFetch });
    const calls = callsByEndpoint(telegramFetch);
    expect(calls.get('sendMessage')?.length).toBe(1);
    expect(calls.get('editMessageText')).toEqual([expect.objectContaining({ chat_id: 8115, message_id: 350 })]);
    const row = await sessionRow(8115);
    expect(row?.['message_id']).toBe(350);
    // The reused panel is immediately interactive on message 350.
    const press = await callWebhook(callbackRequest(8192, 8115, 'a:dashboard', 350), { adminService });
    expect(callsByEndpoint(press.telegramFetch).get('editMessageText')?.length).toBe(1);
  });

  it('callbacks from a different Telegram user cannot operate another admin panel', async () => {
    await seedUser(8105, 'ADMIN');
    await seedUser(8106, 'ADMIN');
    const adminService = new AdminService(env.DB, () => FIXED_NOW);
    await callWebhook(textRequest(8140, 8105, '/admin'), { adminService });
    const { telegramFetch } = await callWebhook(callbackRequest(8141, 8106, 'a:dashboard'), { adminService });
    const calls = callsByEndpoint(telegramFetch);
    expect(calls.get('editMessageText')).toBeUndefined();
    const row = await sessionRow(8105);
    expect(row?.['telegram_user_id']).toBe(8105);
  });

  it('panel activity refreshes the inactivity expiry', async () => {
    await seedUser(8107, 'ADMIN');
    const adminService = new AdminService(env.DB, () => FIXED_NOW);
    await callWebhook(textRequest(8150, 8107, '/admin'), { adminService });
    const before = await sessionRow(8107);
    const minuteLater = new Date(Date.parse(FIXED_NOW) + 60 * 1000).toISOString();
    await callWebhook(callbackRequest(8151, 8107, 'a:dashboard'), { adminService, now: () => minuteLater });
    const after = await sessionRow(8107);
    expect(String(after?.['expires_at']) > String(before?.['expires_at'])).toBe(true);
  });

  it('message editing failure never leaks internals; the session is dropped for a clean reopen', async () => {
    await seedUser(8108, 'ADMIN');
    const adminService = new AdminService(env.DB, () => FIXED_NOW);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await callWebhook(textRequest(8160, 8108, '/admin'), { adminService });
    const failing: FetchMock = vi.fn().mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('editMessageText')) return Promise.resolve(new Response('gone', { status: 500 }));
      return Promise.resolve(okJson());
    });
    const { response } = await callWebhook(callbackRequest(8161, 8108, 'a:dashboard'), { adminService, telegramFetch: failing });
    expect(response.status).toBe(200);
    expect(await sessionRow(8108)).toBeNull();
    const logged = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('webhook_panel_edit_failed');
    expect(logged).not.toContain('gone');
    log.mockRestore();
  });

  it('reopening /admin reuses the same panel message instead of stacking panels', async () => {
    await seedUser(8109, 'ADMIN');
    const adminService = new AdminService(env.DB, () => FIXED_NOW);
    await callWebhook(textRequest(8170, 8109, '/admin'), { adminService });
    const { telegramFetch } = await callWebhook(textRequest(8171, 8109, '/admin'), { adminService });
    const calls = callsByEndpoint(telegramFetch);
    expect(calls.get('editMessageText')?.length).toBe(1);
    expect(calls.get('sendMessage')).toBeUndefined();
  });

  it('/admin after expiration deletes the stale panel message and opens a fresh working panel', async () => {
    await seedUser(8112, 'ADMIN');
    const adminService = new AdminService(env.DB, () => FIXED_NOW);
    await callWebhook(textRequest(8175, 8112, '/admin'), { adminService });
    // Five minutes of inactivity pass (cron may not have cleaned up yet).
    const later = new Date(Date.parse(FIXED_NOW) + 6 * 60 * 1000).toISOString();
    // The fresh panel gets a DIFFERENT Telegram message id.
    const telegramFetch: FetchMock = vi.fn().mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('sendMessage')) return Promise.resolve(okJsonWith(4242));
      return Promise.resolve(okJson());
    });
    const { telegramFetch: reopenFetch } = await callWebhook(textRequest(8176, 8112, '/admin'), { adminService, telegramFetch, now: () => later });
    const calls = callsByEndpoint(reopenFetch);
    // The stale visible panel message is deleted BEFORE the new one opens.
    expect(calls.get('deleteMessage')).toEqual([{ chat_id: 8112, message_id: PANEL_MESSAGE_ID }]);
    expect(calls.get('sendMessage')?.length).toBe(1);
    const row = await sessionRow(8112);
    expect(row?.['message_id']).toBe(4242);
    expect(String(row?.['expires_at'])).toBe(new Date(Date.parse(later) + 5 * 60 * 1000).toISOString());
    // The fresh panel (message 4242) immediately accepts callbacks.
    const nav = await callWebhook(callbackRequest(8177, 8112, 'a:dashboard', 4242), { adminService, now: () => later });
    expect(callsByEndpoint(nav.telegramFetch).get('editMessageText')?.length).toBe(1);
  });
});

describe('scheduled panel cleanup (cron)', () => {
  it('deletes expired panel messages, removes sessions, and notifies exactly once', async () => {
    await seedUser(8201, 'ADMIN');
    await seedUser(8202, 'ADMIN');
    const adminService = new AdminService(env.DB, () => FIXED_NOW);
    const telegramFetch: FetchMock = vi.fn().mockImplementation(() => okJson());
    await callWebhook(textRequest(8200, 8201, '/admin'), { adminService, telegramFetch });
    await callWebhook(textRequest(8201, 8202, '/admin'), { adminService, telegramFetch });
    // Expire only the first admin's panel by back-dating its expiry directly.
    await env.DB.prepare('UPDATE admin_panel_sessions SET expires_at = ? WHERE chat_id = ?')
      .bind(new Date(Date.parse(FIXED_NOW) - 1000).toISOString(), 8201)
      .run();

    const cleaned = await cleanupExpiredPanels(env.DB, BOT_TOKEN, telegramFetch, () => FIXED_NOW);
    expect(cleaned).toBe(1);
    expect(await sessionRow(8201)).toBeNull();
    expect(await sessionRow(8202)).not.toBeNull();
    const calls = callsByEndpoint(telegramFetch);
    expect(calls.get('deleteMessage')).toEqual([{ chat_id: 8201, message_id: PANEL_MESSAGE_ID }]);
    // Exactly ONE close notice, as a plain text message without admin controls.
    const notices = (calls.get('sendMessage') ?? []).filter((body) => String(body['text']).includes('inactivity'));
    expect(notices.length).toBe(1);
    expect(notices[0]?.['reply_markup']).toBeUndefined();

    // Re-running the cron must not delete or notify again for the same session.
    const before = telegramFetch.mock.calls.length;
    const again = await cleanupExpiredPanels(env.DB, BOT_TOKEN, telegramFetch, () => FIXED_NOW);
    expect(again).toBe(0);
    expect(telegramFetch.mock.calls.length).toBe(before);
  });

  it('a transient Telegram delete failure keeps the session retryable; a later run completes cleanup', async () => {
    await seedUser(8203, 'ADMIN');
    const adminService = new AdminService(env.DB, () => FIXED_NOW);
    await callWebhook(textRequest(8203, 8203, '/admin'), { adminService });
    await env.DB.prepare('UPDATE admin_panel_sessions SET expires_at = ?').bind(new Date(Date.parse(FIXED_NOW) - 1000).toISOString()).run();
    // First run: network failure. The session MUST survive for retry and no
    // notice may fire (the panel is still visible in Telegram).
    const failing: FetchMock = vi.fn().mockRejectedValue(new TypeError('network down'));
    const cleaned = await cleanupExpiredPanels(env.DB, BOT_TOKEN, failing, () => FIXED_NOW);
    expect(cleaned).toBe(0);
    expect(await sessionRow(8203)).not.toBeNull();
    // Second run: Telegram recovered. Cleanup completes exactly once.
    const recovered: FetchMock = vi.fn().mockImplementation(() => okJson());
    const cleanedAgain = await cleanupExpiredPanels(env.DB, BOT_TOKEN, recovered, () => FIXED_NOW);
    expect(cleanedAgain).toBe(1);
    expect(await sessionRow(8203)).toBeNull();
    const calls = callsByEndpoint(recovered);
    expect(calls.get('deleteMessage')?.length).toBe(1);
    expect((calls.get('sendMessage') ?? []).filter((b) => String(b['text']).includes('inactivity')).length).toBe(1);
    // And a third run neither deletes nor notifies again.
    const before = recovered.mock.calls.length;
    expect(await cleanupExpiredPanels(env.DB, BOT_TOKEN, recovered, () => FIXED_NOW)).toBe(0);
    expect(recovered.mock.calls.length).toBe(before);
  });

  it('Telegram "message to delete not found" is treated as already gone: session cleaned, notice sent', async () => {
    await seedUser(8205, 'ADMIN');
    const adminService = new AdminService(env.DB, () => FIXED_NOW);
    await callWebhook(textRequest(8205, 8205, '/admin'), { adminService });
    await env.DB.prepare('UPDATE admin_panel_sessions SET expires_at = ?').bind(new Date(Date.parse(FIXED_NOW) - 1000).toISOString()).run();
    const goneFetch: FetchMock = vi.fn().mockImplementation((input: string | URL | Request) => {
      if (String(input).includes('deleteMessage')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: message to delete not found' }), { status: 400 }));
      }
      return Promise.resolve(okJson());
    });
    const cleaned = await cleanupExpiredPanels(env.DB, BOT_TOKEN, goneFetch, () => FIXED_NOW);
    expect(cleaned).toBe(1);
    expect(await sessionRow(8205)).toBeNull();
    const calls = callsByEndpoint(goneFetch);
    expect((calls.get('sendMessage') ?? []).filter((b) => String(b['text']).includes('inactivity')).length).toBe(1);
  });

  it('one failing panel does not block other expired panels in the same run', async () => {
    await seedUser(8206, 'ADMIN');
    await seedUser(8207, 'ADMIN');
    const adminService = new AdminService(env.DB, () => FIXED_NOW);
    const telegramFetch: FetchMock = vi.fn().mockImplementation(() => okJson());
    await callWebhook(textRequest(8206, 8206, '/admin'), { adminService, telegramFetch });
    await callWebhook(textRequest(8207, 8207, '/admin'), { adminService, telegramFetch });
    await env.DB.prepare('UPDATE admin_panel_sessions SET expires_at = ?').bind(new Date(Date.parse(FIXED_NOW) - 1000).toISOString()).run();
    // Transient delete failures for BOTH: both sessions survive for retry...
    const failing: FetchMock = vi.fn().mockRejectedValue(new TypeError('network down'));
    expect(await cleanupExpiredPanels(env.DB, BOT_TOKEN, failing, () => FIXED_NOW)).toBe(0);
    expect(await sessionRow(8206)).not.toBeNull();
    expect(await sessionRow(8207)).not.toBeNull();
    // ...and BOTH are processed on the next (recovered) run.
    const cleaned = await cleanupExpiredPanels(env.DB, BOT_TOKEN, telegramFetch, () => FIXED_NOW);
    expect(cleaned).toBe(2);
    expect(await sessionRow(8206)).toBeNull();
    expect(await sessionRow(8207)).toBeNull();
  });

  it('does nothing without a bot token (fail closed)', async () => {
    const cleaned = await cleanupExpiredPanels(env.DB, undefined, globalThis.fetch, () => FIXED_NOW);
    expect(cleaned).toBe(0);
  });

  it('scheduled handler invokes the cleanup under waitUntil', async () => {
    const worker = (await import('../src/index')).default;
    await seedUser(8204, 'ADMIN');
    const adminService = new AdminService(env.DB, () => FIXED_NOW);
    await callWebhook(textRequest(8204, 8204, '/admin'), { adminService });
    // The scheduled handler uses the real clock and the real global fetch;
    // expire relative to Date.now() and stub the global fetch (the handler
    // passes no fetchImpl) so Telegram deletes/notice succeed.
    await env.DB.prepare('UPDATE admin_panel_sessions SET expires_at = ?').bind(new Date(Date.now() - 1000).toISOString()).run();
    const fetchStub = vi.fn().mockImplementation(() => okJson());
    vi.stubGlobal('fetch', fetchStub);
    try {
      const waited: Promise<unknown>[] = [];
      const ctx = { waitUntil: (p: Promise<unknown>) => { waited.push(p); }, passThroughOnException: () => undefined };
      await worker.scheduled({ cron: '* * * * *' } as ScheduledController, makeEnv(), ctx as unknown as ExecutionContext);
      await Promise.all(waited);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(await sessionRow(8204)).toBeNull();
  });
});
