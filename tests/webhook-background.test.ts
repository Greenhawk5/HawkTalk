// Regression tests for the 60-second Telegram webhook cancellation
// (production: outcome "canceled", wallTime ~59.996s). The webhook must
// acknowledge Telegram promptly after the durable claim while conversational
// processing (AI Router / provider I/O) continues under
// ExecutionContext.waitUntil, preserving the durable idempotency state
// machine (claimed → generating → completed | failed).
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { route } from '../src/router';
import { D1ConversationOrchestrator } from '../src/orchestration/conversation-orchestrator';
import { D1ConversationRepository } from '../src/db/conversation-d1';
import { D1ProcessingRepository } from '../src/orchestration/processing-d1';
import type { ConversationFlowDeps } from '../src/orchestration/service';
import type { ConversationFlowFactory } from '../src/telegram/webhook';
import type { ModelProvider, ProviderGenerateInput, ProviderGenerateResult } from '../src/agent/provider';
import type { AppEnv } from '../src/env';

const URL_BASE = 'https://hawktalk.test';
const WEBHOOK_URL = `${URL_BASE}/telegram/webhook`;
const WEBHOOK_SECRET = 'test-webhook-secret-bg';
const BOT_TOKEN = 'test-bot-token-bg';
const FIXED_NOW = '2026-09-21T12:00:00.000Z';

function makeEnv(): Partial<AppEnv> {
  return { APP_ENV: 'development', DB: env.DB, TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET };
}

function telegramOk(): Response {
  return Response.json({ ok: true, result: { message_id: 9 } });
}

function webhookRequest(updateId: number, userId: number, text = 'hello'): Request {
  const headers = new Headers();
  headers.set('X-Telegram-Bot-Api-Secret-Token', WEBHOOK_SECRET);
  headers.set('content-type', 'application/json');
  const body = JSON.stringify({
    update_id: updateId,
    message: {
      message_id: 1,
      from: { id: userId, is_bot: false, first_name: 'Ada' },
      chat: { id: userId, type: 'private' },
      date: 1726579200,
      text,
    },
  });
  return new Request(WEBHOOK_URL, { method: 'POST', headers, body });
}

/** Provider whose generate() blocks until released — emulating a slow (e.g. 60s) provider. */
function deferredProvider(): { provider: ModelProvider; release: () => void; generate: ReturnType<typeof vi.fn> } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const generate = vi.fn(async (input: ProviderGenerateInput): Promise<ProviderGenerateResult> => {
    await gate;
    return { text: `echo:${[...input.messages].reverse().find((m) => m.role === 'user')?.content ?? ''}`, model: 'acme:m' };
  });
  return { provider: { id: 'fake', generate }, release, generate };
}

function flowFactory(userId: number, provider: ModelProvider, requestId: string, overrides: Partial<ConversationFlowDeps> = {}): ConversationFlowFactory {
  return (_reqId: string, internalUserId: number) => ({
    orchestrator: new D1ConversationOrchestrator(env.DB, new D1ConversationRepository(env.DB)),
    processing: new D1ProcessingRepository(env.DB),
    admission: { admit: async () => 'allowed' },
    provider,
    requestId,
    agentUserId: String(userId),
    userId: internalUserId,
    model: 'router',
    systemPrompt: 'You are HawkTalk.',
    ...overrides,
  });
}

function waitUntilCollector(): { waitUntil: (promise: Promise<unknown>) => void; background: () => Promise<unknown[]> } {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil: (p) => {
      promises.push(p);
    },
    // Called late (after releasing the provider), so it observes all pushed
    // background promises.
    background: () => Promise.all(promises),
  };
}

async function processingState(updateId: number): Promise<string | null> {
  const row = await env.DB.prepare('SELECT processing_state FROM processed_updates WHERE update_id = ?').bind(updateId).first<{ processing_state: string }>();
  return row?.processing_state ?? null;
}


describe('telegram webhook background execution (60s cancellation regression)', () => {
  it('acknowledges Telegram before a slow provider generation completes, then delivers in background', async () => {
    const { provider, release, generate } = deferredProvider();
    const telegramFetch = vi.fn().mockImplementation(() => telegramOk());
    const collector = waitUntilCollector();

    const response = await route(webhookRequest(5001, 5101), {
      env: makeEnv(),
      requestId: 'bg-req-1',
      telegramFetch,
      now: () => FIXED_NOW,
      flow: flowFactory(5101, provider, 'bg-req-1'),
      ...collector,
    });

    // The HTTP response resolves while generation is still pending — Telegram
    // gets its 200 well inside the ~60s webhook deadline.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    expect(telegramFetch).not.toHaveBeenCalled();
    expect(await processingState(5001)).toBe('generating');

    release();
    await collector.background();

    expect(telegramFetch).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(telegramFetch.mock.calls[0]?.[1]?.body)) as { text: string };
    expect(payload.text).toBe('echo:hello');
    expect(await processingState(5001)).toBe('completed');
  });

  it('never regenerates on redelivery after background completion; redelivery re-delivers the durable result', async () => {
    const { provider, release, generate } = deferredProvider();
    const telegramFetch = vi.fn().mockImplementation(() => telegramOk());
    const collector = waitUntilCollector();

    await route(webhookRequest(5002, 5102), {
      env: makeEnv(),
      requestId: 'bg-req-2',
      telegramFetch,
      now: () => FIXED_NOW,
      flow: flowFactory(5102, provider, 'bg-req-2'),
      ...collector,
    });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    // Concurrent redelivery before completion: duplicate path, no generation.
    const dup = await route(webhookRequest(5002, 5102), { env: makeEnv(), requestId: 'bg-req-2b', telegramFetch, now: () => FIXED_NOW });
    expect(dup.status).toBe(200);
    expect(generate).toHaveBeenCalledTimes(1);
    release();
    await collector.background();
    expect(telegramFetch).toHaveBeenCalledTimes(1);

    // Redelivery after completion: reuse the persisted assistant text — no AI.
    const second = await route(webhookRequest(5002, 5102), { env: makeEnv(), requestId: 'bg-req-2c', telegramFetch, now: () => FIXED_NOW, flow: flowFactory(5102, provider, 'bg-req-2c') });
    expect(second.status).toBe(200);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(telegramFetch).toHaveBeenCalledTimes(2);
    const payload = JSON.parse(String(telegramFetch.mock.calls[1]?.[1]?.body)) as { text: string };
    expect(payload.text).toBe('echo:hello');
    expect(await processingState(5002)).toBe('completed');
  });

  it('releases the claim on pre-generation background failure so redelivery can reprocess; logs carry no content', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const provider: ModelProvider = { id: 'fake', generate: vi.fn() };
    const telegramFetch = vi.fn().mockImplementation(() => telegramOk());
    const collector = waitUntilCollector();

    const response = await route(webhookRequest(5003, 5103), {
      env: makeEnv(),
      requestId: 'bg-req-3',
      telegramFetch,
      now: () => FIXED_NOW,
      // Pre-generation failure: admission unavailable → claim released.
      flow: flowFactory(5103, provider, 'bg-req-3', { admission: { admit: async () => 'unavailable' } }),
      ...collector,
    });
    expect(response.status).toBe(200);
    await collector.background();

    expect(provider.generate).not.toHaveBeenCalled();
    expect(await processingState(5003)).toBeNull();
    expect(telegramFetch).not.toHaveBeenCalled();
    const logged = log.mock.calls.map((c) => String(c[0]));
    expect(logged.some((line) => line.includes('webhook_flow_failed'))).toBe(true);
    for (const line of logged) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(Object.keys(parsed)).toEqual(expect.arrayContaining(['event', 'request_id']));
    }
    log.mockRestore();
  });
});

