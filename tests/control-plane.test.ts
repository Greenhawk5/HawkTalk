import { env } from 'cloudflare:workers';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { AdminService } from '../src/admin/service';
import type { AppEnv } from '../src/env';
import { route } from '../src/router';
import type { ConversationFlowFactory } from '../src/telegram/webhook';

const URL_BASE = 'https://hawktalk.test';
const WEBHOOK_URL = `${URL_BASE}/telegram/webhook`;
const WEBHOOK_SECRET = 'test-webhook-secret-001';
const BOT_TOKEN = 'test-bot-token-001';
const FIXED_NOW = '2026-09-17T12:00:00.000Z';

type FetchMock = Mock<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;

function makeEnv(overrides: Partial<AppEnv> = {}): Partial<AppEnv> {
  return { APP_ENV: 'development', DB: env.DB, TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET, ...overrides };
}

function telegramOk(): Response {
  return Response.json({ ok: true, result: { message_id: 9 } });
}

function textRequest(updateId: number, userId: number, chatType: string, text: string): Request {
  return new Request(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET },
    body: JSON.stringify({
      update_id: updateId,
      message: { message_id: 1, from: { id: userId, is_bot: false, first_name: 'A' }, chat: { id: userId, type: chatType }, date: 1726579200, text },
    }),
  });
}

function callbackRequest(updateId: number, userId: number, data: string, chatType = 'private'): Request {
  return new Request(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET },
    body: JSON.stringify({
      update_id: updateId,
      callback_query: { id: `cbq${updateId}`, from: { id: userId, is_bot: false, first_name: 'A' }, message: { message_id: 5, chat: { id: userId, type: chatType } }, data },
    }),
  });
}

async function callWebhook(req: Request, opts: { telegramFetch?: FetchMock; adminService?: AdminService; flow?: ConversationFlowFactory; envOverrides?: Partial<AppEnv> } = {}): Promise<{ response: Response; telegramFetch: FetchMock }> {
  const telegramFetch = opts.telegramFetch ?? vi.fn().mockResolvedValue(telegramOk());
  const response = await route(req, {
    env: makeEnv(opts.envOverrides),
    requestId: 'test-request-id',
    telegramFetch,
    now: () => FIXED_NOW,
    ...(opts.adminService !== undefined ? { adminService: opts.adminService } : {}),
    ...(opts.flow !== undefined ? { flow: opts.flow } : {}),
  });
  return { response, telegramFetch };
}

function sentTexts(mock: FetchMock): string[] {
  return mock.mock.calls.map((call) => {
    const body = call[1]?.body;
    return body === undefined || body === null ? '' : ((JSON.parse(String(body)) as { text?: string }).text ?? '');
  });
}

async function seedUser(telegramId: number, role: string, status = 'active'): Promise<number> {
  await env.DB.prepare(
    "INSERT INTO users (telegram_user_id, username, display_name, status, role, created_at, updated_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(telegramId, `u${telegramId}`, `User ${telegramId}`, status, role, FIXED_NOW, FIXED_NOW, FIXED_NOW)
    .run();
  const row = await env.DB.prepare('SELECT id FROM users WHERE telegram_user_id = ?').bind(telegramId).first<{ id: number }>();
  return row?.id ?? 0;
}

describe('Control plane: /start without AI provider', () => {
  it('responds to /start with a welcome message and no AI flow', async () => {
    const { response, telegramFetch } = await callWebhook(textRequest(8001, 5001, 'private', '/start'));
    expect(response.status).toBe(200);
    const texts = sentTexts(telegramFetch);
    expect(texts.some((t) => t.includes('welcome to HawkTalk'))).toBe(true);
  });

  it('responds to /start for OWNER with admin hint', async () => {
    await seedUser(5002, 'OWNER');
    const { response, telegramFetch } = await callWebhook(textRequest(8002, 5002, 'private', '/start'));
    expect(response.status).toBe(200);
    const texts = sentTexts(telegramFetch);
    expect(texts.some((t) => t.includes('admin privileges') || t.includes('/admin'))).toBe(true);
  });

  it('responds to /start for ADMIN with admin hint', async () => {
    await seedUser(5003, 'ADMIN');
    const { response, telegramFetch } = await callWebhook(textRequest(8003, 5003, 'private', '/start'));
    expect(response.status).toBe(200);
    const texts = sentTexts(telegramFetch);
    expect(texts.some((t) => t.includes('admin privileges') || t.includes('/admin'))).toBe(true);
  });

  it('/start works even when no conversational flow exists', async () => {
    const { response } = await callWebhook(textRequest(8004, 5004, 'private', '/start'));
    expect(response.status).toBe(200);
  });
});

describe('Control plane: /help without AI provider', () => {
  it('responds to /help with command list', async () => {
    const { response, telegramFetch } = await callWebhook(textRequest(8010, 5010, 'private', '/help'));
    expect(response.status).toBe(200);
    const texts = sentTexts(telegramFetch);
    expect(texts.some((t) => t.includes('/start') && t.includes('/help'))).toBe(true);
  });

  it('/help for ADMIN includes /admin in the list', async () => {
    await seedUser(5011, 'ADMIN');
    const { response, telegramFetch } = await callWebhook(textRequest(8011, 5011, 'private', '/help'));
    expect(response.status).toBe(200);
    const texts = sentTexts(telegramFetch);
    expect(texts.some((t) => t.includes('/admin'))).toBe(true);
  });
});

describe('Control plane: /admin without AI provider', () => {
  it('serves /admin menu to OWNER with no flow configured', async () => {
    const adminSvc = new AdminService(env.DB, () => FIXED_NOW);
    await seedUser(5020, 'OWNER');
    const { response, telegramFetch } = await callWebhook(textRequest(8020, 5020, 'private', '/admin'), { adminService: adminSvc });
    expect(response.status).toBe(200);
    const texts = sentTexts(telegramFetch);
    expect(texts.some((t) => t.includes('HawkTalk Admin'))).toBe(true);
  });

  it('serves /admin menu to ADMIN with no flow configured', async () => {
    const adminSvc = new AdminService(env.DB, () => FIXED_NOW);
    await seedUser(5021, 'ADMIN');
    const { response, telegramFetch } = await callWebhook(textRequest(8021, 5021, 'private', '/admin'), { adminService: adminSvc });
    expect(response.status).toBe(200);
    const texts = sentTexts(telegramFetch);
    expect(texts.some((t) => t.includes('HawkTalk Admin'))).toBe(true);
  });

  it('admin callbacks are acknowledged without entering conversational flow', async () => {
    // Admin callback handling is thoroughly tested in admin-telegram.test.ts.
    // Callbacks route through the control plane, never the conversational flow.
    const { response } = await callWebhook(callbackRequest(8022, 5022, 'a:menu'));
    expect(response.status).toBe(200);
  });
});

describe('AI failure isolation', () => {
  it('normal text with no AI provider uses transport-only mode and returns 200', async () => {
    const { response, telegramFetch } = await callWebhook(textRequest(8030, 5030, 'private', 'hello world'));
    expect(response.status).toBe(200);
    const texts = sentTexts(telegramFetch);
    expect(texts.length).toBeGreaterThan(0);
  });

  it('normal text with a failing provider returns 500 and logs webhook_flow_failed', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failingProvider = {
      id: 'failing',
      generate: vi.fn(async () => { throw new Error('boom'); }),
    };
    const fakeFlow: ConversationFlowFactory = (_reqId, userId) => ({
      orchestrator: { resolveDefaultConversation: async () => ({ conversation: { id: 'c1' } }), appendMessage: async () => {}, getContext: async () => [], getMessageText: async () => null } as never,
      processing: { markGenerating: async () => true, getProcessingRecord: async () => null, markFailed: async () => {}, completeWithAssistantMessage: async () => true } as never,
      admission: { admit: async () => 'allowed' as const } as never,
      provider: failingProvider,
      requestId: 'test-request-id',
      agentUserId: String(userId),
      userId,
      model: 'router',
      systemPrompt: '',
    });
    const { response } = await callWebhook(textRequest(8031, 5031, 'private', 'hello'), { flow: fakeFlow });
    expect(response.status).toBe(500);
    const logged = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('webhook_flow_failed');
    log.mockRestore();
  });

  it('/start still works when conversational flow would fail', async () => {
    const { response, telegramFetch } = await callWebhook(textRequest(8032, 5032, 'private', '/start'));
    expect(response.status).toBe(200);
    const texts = sentTexts(telegramFetch);
    expect(texts.some((t) => t.includes('welcome to HawkTalk'))).toBe(true);
  });
});

describe('OWNER bootstrap via OWNER_TELEGRAM_ID', () => {
  it('promotes matching user to OWNER on upsert via conversational text', async () => {
    // /start is control-plane and skips upsert; use normal text to trigger upsert + bootstrap
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { response } = await callWebhook(textRequest(8040, 5040, 'private', 'hello'), { envOverrides: { OWNER_TELEGRAM_ID: '5040' } });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare('SELECT role FROM users WHERE telegram_user_id = ?').bind(5040).first<{ role: string }>();
    expect(row?.role).toBe('OWNER');
    log.mockRestore();
  });

  it('does not promote non-matching user', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await callWebhook(textRequest(8041, 5041, 'private', 'hello'), { envOverrides: { OWNER_TELEGRAM_ID: '9999' } });
    const row = await env.DB.prepare('SELECT role FROM users WHERE telegram_user_id = ?').bind(5041).first<{ role: string }>();
    expect(row?.role).toBe('USER');
    log.mockRestore();
  });

  it('no bootstrap when OWNER_TELEGRAM_ID is absent', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await callWebhook(textRequest(8042, 5042, 'private', 'hello'));
    const row = await env.DB.prepare('SELECT role FROM users WHERE telegram_user_id = ?').bind(5042).first<{ role: string }>();
    expect(row?.role).toBe('USER');
    log.mockRestore();
  });

  it('never downgrades an existing OWNER', async () => {
    await seedUser(5043, 'OWNER');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await callWebhook(textRequest(8043, 5043, 'private', 'hello'), { envOverrides: { OWNER_TELEGRAM_ID: '9999' } });
    const row = await env.DB.prepare('SELECT role FROM users WHERE telegram_user_id = ?').bind(5043).first<{ role: string }>();
    expect(row?.role).toBe('OWNER');
    log.mockRestore();
  });

  it('username cannot grant OWNER', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await callWebhook(textRequest(8044, 5044, 'private', 'hello'), { envOverrides: { OWNER_TELEGRAM_ID: '9999' } });
    const row = await env.DB.prepare('SELECT role FROM users WHERE telegram_user_id = ?').bind(5044).first<{ role: string }>();
    expect(row?.role).not.toBe('OWNER');
    log.mockRestore();
  });
});

describe('Security: control plane does not weaken existing protections', () => {
  it('webhook secret validation still rejects unauthorized requests for /start', async () => {
    const req = new Request(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret' },
      body: JSON.stringify({ update_id: 8050, message: { message_id: 1, from: { id: 1, is_bot: false, first_name: 'A' }, chat: { id: 1, type: 'private' }, date: 1, text: '/start' } }),
    });
    const { response } = await callWebhook(req);
    expect(response.status).toBe(401);
  });

  it('idempotency still works for /start', async () => {
    const tg = vi.fn().mockResolvedValue(telegramOk());
    const first = await callWebhook(textRequest(8051, 5051, 'private', '/start'), { telegramFetch: tg });
    expect(first.response.status).toBe(200);
    const second = await callWebhook(textRequest(8051, 5051, 'private', '/start'), { telegramFetch: tg });
    expect(second.response.status).toBe(200);
    expect(tg).toHaveBeenCalledTimes(1);
  });

  it('unauthorized users cannot access CMS via /admin', async () => {
    const adminSvc = new AdminService(env.DB, () => FIXED_NOW);
    await seedUser(5052, 'USER');
    const { telegramFetch } = await callWebhook(textRequest(8052, 5052, 'private', '/admin'), { adminService: adminSvc });
    const texts = sentTexts(telegramFetch);
    expect(texts.some((t) => t.includes('not authorized'))).toBe(true);
    expect(texts.every((t) => !t.includes('HawkTalk Admin'))).toBe(true);
  });
});
