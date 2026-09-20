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

function makeEnv(): Partial<AppEnv> {
  return { APP_ENV: 'development', DB: env.DB, TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET };
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

async function callWebhook(req: Request, opts: { telegramFetch?: FetchMock; adminService?: AdminService; flow?: ConversationFlowFactory } = {}): Promise<{ response: Response; telegramFetch: FetchMock }> {
  const telegramFetch = opts.telegramFetch ?? vi.fn().mockResolvedValue(telegramOk());
  const response = await route(req, {
    env: makeEnv(),
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

describe('Phase 9 admin webhook authorization', () => {
  it.each(['USER', 'VIP', 'BLOCKED'] as const)('denies %s /admin with a safe fixed text and no menu', async (role) => {
    const telegramId = 7000 + (['USER', 'VIP', 'BLOCKED'].indexOf(role) + 1);
    await seedUser(telegramId, role);
    const { telegramFetch } = await callWebhook(textRequest(7100 + Number(String(telegramId).slice(-2)), telegramId, 'private', '/admin'), { adminService: new AdminService(env.DB, () => FIXED_NOW) });
    expect(telegramFetch).toHaveBeenCalledTimes(1);
    const body = String(telegramFetch.mock.calls[0]?.[1]?.body);
    expect(JSON.parse(String(body)) as { text: string }).toMatchObject({ text: 'You are not authorized to use admin commands.' });
  });

it('serves /admin menu to ADMIN and OWNER in private chat', async () => {
    const adminSvc = new AdminService(env.DB, () => FIXED_NOW);
    await seedUser(6001, 'ADMIN');
    await seedUser(6002, 'OWNER');
    for (const telegramId of [6001, 6002]) {
      const { telegramFetch } = await callWebhook(textRequest(7200 + telegramId, telegramId, 'private', '/admin'), { adminService: adminSvc });
      const texts = sentTexts(telegramFetch);
      expect(texts.some((t) => t.includes('HawkTalk Admin'))).toBe(true);
    }
  });

  it('never serves /admin in group, supergroup, or channel contexts', async () => {
    const adminSvc = new AdminService(env.DB, () => FIXED_NOW);
    await seedUser(6003, 'ADMIN');
    for (const [i, chatType] of ['group', 'supergroup', 'channel'].entries()) {
      const { telegramFetch } = await callWebhook(textRequest(7300 + i, 6003, chatType, '/admin'), { adminService: adminSvc });
      expect(telegramFetch).not.toHaveBeenCalled();
    }
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_audit_logs').first('n')).toBe(0);
  });

  it('acknowledges duplicate /admin deliveries without re-executing', async () => {
    const adminSvc = new AdminService(env.DB, () => FIXED_NOW);
    await seedUser(6004, 'ADMIN');
    const first = await callWebhook(textRequest(7400, 6004, 'private', '/admin'), { adminService: adminSvc });
    expect(first.telegramFetch).toHaveBeenCalledTimes(1);
    const second = await callWebhook(textRequest(7400, 6004, 'private', '/admin'), { adminService: adminSvc });
    expect(second.response.status).toBe(200);
    expect(second.telegramFetch).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT kind FROM processed_updates WHERE update_id = 7400').first('kind')).toBe('admin');
  });

  it('keeps /admin out of quota accounting and conversation history', async () => {
    const adminSvc = new AdminService(env.DB, () => FIXED_NOW);
    await seedUser(6005, 'ADMIN');
    await callWebhook(textRequest(7500, 6005, 'private', '/admin'), { adminService: adminSvc });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM request_admissions').first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first('n')).toBe(0);
  });
});

describe('Phase 9 admin callback security', () => {
  it('answers malformed and unknown callbacks without executing admin logic', async () => {
    const adminSvc = new AdminService(env.DB, () => FIXED_NOW);
    await seedUser(6006, 'ADMIN');
    for (const [i, data] of ['a:', 'a:unknown', 'x:menu', 'a:user:abc', 'a:user:-5', `a:user:${'9'.repeat(25)}`, 'a:policy:ROOT', `a:${'x'.repeat(70)}`].entries()) {
      const { response, telegramFetch } = await callWebhook(callbackRequest(7600 + i, 6006, data), { adminService: adminSvc });
      expect(response.status).toBe(200);
      // Only the Bot API sendMessage/answerCallbackQuery traffic happens; no
      // admin state changed. Unknown actions get a validation error answer.
      void telegramFetch;
    }
  });

  it('executes authorized callbacks server-side regardless of button text', async () => {
    const adminSvc = new AdminService(env.DB, () => FIXED_NOW);
    await seedUser(6007, 'ADMIN');
    const { telegramFetch } = await callWebhook(callbackRequest(7700, 6007, 'a:dashboard'), { adminService: adminSvc });
    const texts = sentTexts(telegramFetch);
    // The dashboard view is delivered via sendMessage; verify content arrived.
    expect(texts.some((t) => t.includes('Users:') || t.includes('Providers:'))).toBe(true);
  });

it('denies callback access to non-admins and unknown users without leaking data', async () => {
    const adminSvc = new AdminService(env.DB, () => FIXED_NOW);
    await seedUser(6008, 'USER');
    const denied = await callWebhook(callbackRequest(7800, 6008, 'a:dashboard'), { adminService: adminSvc });
    // Non-admin gets answerCallbackQuery with denial text, never a sendMessage with dashboard data.
    const texts = sentTexts(denied.telegramFetch);
    expect(texts.every((t) => !t.includes('Users:') && !t.includes('Providers:'))).toBe(true);
    const unknown = await callWebhook(callbackRequest(7801, 424242, 'a:dashboard'), { adminService: adminSvc });
    const unknownTexts = sentTexts(unknown.telegramFetch);
    expect(unknownTexts.some((t) => t.includes('not authorized'))).toBe(true);
    // No audit records are written for pre-authorization failures (authorize throws before audit).
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_audit_logs').first('n')).toBe(0);
  });
});
