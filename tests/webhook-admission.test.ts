import { env } from 'cloudflare:workers';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { D1AdmissionGate } from '../src/db/admission-d1';
import { countProcessedUpdates } from '../src/db/telegram';
import type { ModelProvider, ProviderGenerateInput, ProviderGenerateResult } from '../src/agent/provider';
import type { ConversationFlowDeps } from '../src/orchestration/service';
import { D1ConversationOrchestrator } from '../src/orchestration/conversation-orchestrator';
import { D1ProcessingRepository } from '../src/orchestration/processing-d1';
import { D1ConversationRepository } from '../src/db/conversation-d1';
import type { AdmissionDecision, AdmissionGate } from '../src/orchestration/admission';
import type { ConversationFlowFactory } from '../src/telegram/webhook';
import { route } from '../src/router';
import type { AppEnv } from '../src/env';

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

function webhookRequest(updateId: number, userId: number, text: string): Request {
  return new Request(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET },
    body: JSON.stringify({
      update_id: updateId,
      message: { message_id: 1, from: { id: userId, is_bot: false, first_name: 'Ada' }, chat: { id: userId, type: 'private' }, date: 1726579200, text },
    }),
  });
}

async function callWebhook(
  req: Request,
  opts: { telegramFetch?: FetchMock; flow?: ConversationFlowFactory } = {},
): Promise<{ response: Response; telegramFetch: FetchMock }> {
  const telegramFetch = opts.telegramFetch ?? vi.fn().mockResolvedValue(telegramOk());
  const response = await route(req, {
    env: makeEnv(),
    requestId: 'test-request-id',
    telegramFetch,
    now: () => FIXED_NOW,
    ...(opts.flow !== undefined ? { flow: opts.flow } : {}),
  });
  return { response, telegramFetch };
}

function flowProvider(): ModelProvider {
  return {
    id: 'fake-provider',
    generate: vi.fn(async (input: ProviderGenerateInput): Promise<ProviderGenerateResult> => ({
      text: `ai:${[...input.messages].reverse().find((message) => message.role === 'user')?.content ?? ''}`,
      model: 'fake-model',
    })),
  };
}

function staticGate(decision: AdmissionDecision): AdmissionGate {
  return { admit: vi.fn(async () => decision) };
}

function deps(userId: number, provider: ModelProvider, requestId: string, gate: AdmissionGate): ConversationFlowDeps {
  return {
    admission: gate,
    orchestrator: new D1ConversationOrchestrator(env.DB, new D1ConversationRepository(env.DB)),
    processing: new D1ProcessingRepository(env.DB),
    provider,
    requestId,
    agentUserId: String(userId),
    userId,
    model: 'router',
    systemPrompt: 'You are HawkTalk.',
  };
}

const generateCalls = (provider: ModelProvider): Mock => (provider as unknown as { generate: Mock }).generate;

describe('Phase 8 webhook admission enforcement', () => {
  it.each(['quota_exceeded', 'rate_limited', 'blocked'] as const)('replies safely on %s without AI, conversation rows, or claim loss', async decision => {
    const provider = flowProvider();
    const { response, telegramFetch } = await callWebhook(webhookRequest(3101, 9701, 'hello'), {
      flow: (requestId, userId) => deps(userId, provider, requestId, staticGate(decision)),
    });
    expect(response.status).toBe(200);
    const call = telegramFetch.mock.calls[0];
    expect(call).toBeDefined();
    const payload = JSON.parse(String(call?.[1]?.body)) as { text: string };
    expect(payload.text).not.toContain('ai:');
    expect(payload.text.length).toBeGreaterThan(0);
    expect(generateCalls(provider)).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM conversations').first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first('n')).toBe(0);
    // The claim stays: the durable decision covers any redelivery of this update.
    expect(await countProcessedUpdates(env.DB, 3101)).toBe(1);
  });

  it('maps admission unavailability to a 500 pre-generation failure that releases the claim', async () => {
    const provider = flowProvider();
    const { response } = await callWebhook(webhookRequest(3102, 9702, 'retry me'), {
      flow: (requestId, userId) => deps(userId, provider, requestId, staticGate('unavailable')),
    });
    expect(response.status).toBe(500);
    expect(generateCalls(provider)).not.toHaveBeenCalled();
    expect(await countProcessedUpdates(env.DB, 3102)).toBe(0);
  });

  it('redelivery after a deterministic rejection reuses the durable admission decision without double-charging', async () => {
    const provider = flowProvider();
    await env.DB.prepare(
      "INSERT INTO users (telegram_user_id, username, display_name, status, created_at, updated_at, last_seen) VALUES (?, 'ada', 'Ada', 'active', ?, ?, ?)",
    )
      .bind(9703, FIXED_NOW, FIXED_NOW, FIXED_NOW)
      .run();
    const gate = new D1AdmissionGate(env.DB, { now: () => FIXED_NOW });
    const flow: ConversationFlowFactory = (requestId, userId) => deps(userId, provider, requestId, gate);
    // Low policy: exactly one allowed USER message.
    await env.DB.prepare("UPDATE admission_policies SET daily_messages = 1 WHERE role = 'USER'").run();
    for (let i = 0; i < 2; i += 1) {
      await callWebhook(webhookRequest(3103, 9703, 'once'), { flow });
    }
    expect(generateCalls(provider)).toHaveBeenCalledTimes(1);
    const quotaUnits = await env.DB.prepare('SELECT SUM(quota_units) AS n FROM request_admissions').first<{ n: number }>();
    expect(quotaUnits?.n).toBe(1);
  });

  it('keeps transport-only mode (no master secret) free of admission writes', async () => {
    const { response, telegramFetch } = await callWebhook(webhookRequest(3104, 9704, 'hello'), {});
    expect(response.status).toBe(200);
    expect(telegramFetch).toHaveBeenCalledTimes(1);
    const call = telegramFetch.mock.calls[0];
    const payload = JSON.parse(String(call?.[1]?.body)) as { text: string };
    expect(payload.text).not.toContain('9704');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM request_admissions').first('n')).toBe(0);
  });
});
