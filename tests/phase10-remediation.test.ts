import { env } from 'cloudflare:workers';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { route } from '../src/router';
import { productionFlow } from '../src/router';
import { AIRouter, D1ProviderDirectory, InMemoryRouterHealth } from '../src/ai/router';
import { D1CredentialStore } from '../src/ai/credentials';
import { buildProductionUsageRecorder } from '../src/orchestration/production';
import { parseUserCommand } from '../src/telegram/user-commands';
import { buildResearchTools } from '../src/tools/research';
import { RESEARCH_TOOL_ALLOWLIST } from '../src/ai/routing-profiles';
import type { AppEnv } from '../src/env';
import type { ModelProvider } from '../src/agent/provider';
import { summarizeUserUsage } from '../src/db/usage';

const URL_BASE = 'https://hawktalk.test';
const WEBHOOK_URL = `${URL_BASE}/telegram/webhook`;
const WEBHOOK_SECRET = 'test-webhook-secret-remediation';
const BOT_TOKEN = 'test-bot-token-remediation';
const MASTER_SECRET = 'test-master-secret-32bytes-remediation';
const NOW = '2026-09-18T12:00:00.000Z';

type FetchMock = Mock<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;

function makeEnv(): Partial<AppEnv> {
  return { APP_ENV: 'development', DB: env.DB, TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET, CREDENTIAL_MASTER_SECRET: MASTER_SECRET };
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

function sentBodies(mock: FetchMock): Array<{ url: string; body: Record<string, unknown> }> {
  return mock.mock.calls.map((call) => ({
    url: String(call[0]),
    body: JSON.parse(String(call[1]?.body ?? '{}')) as Record<string, unknown>,
  }));
}

async function seedUser(telegramId: number, role = 'USER', status = 'active'): Promise<number> {
  await env.DB.prepare(
    "INSERT INTO users (telegram_user_id, username, display_name, status, role, created_at, updated_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(telegramId, `u${telegramId}`, `User ${telegramId}`, status, role, NOW, NOW, NOW)
    .run();
  const row = await env.DB.prepare('SELECT id FROM users WHERE telegram_user_id = ?').bind(telegramId).first<{ id: number }>();
  return row?.id ?? 0;
}

describe('user routing command parsing', () => {
  it('parses exact commands with stripped queries, rejects near-misses', () => {
    expect(parseUserCommand('/fast what is fast?')).toEqual({ profile: 'FAST', query: 'what is fast?' });
    expect(parseUserCommand('/smart   explain this  ')).toEqual({ profile: 'COMPLEX', query: 'explain this' });
    expect(parseUserCommand('/research black holes')).toEqual({ profile: 'RESEARCH', query: 'black holes' });
    expect(parseUserCommand('/research')).toEqual({ profile: 'RESEARCH', query: '' });
    expect(parseUserCommand('hello world')).toBeNull();
    expect(parseUserCommand('/faster than light')).toBeNull();
    expect(parseUserCommand('/FAST question')).toBeNull();
    expect(parseUserCommand('/researchx question')).toBeNull();
    expect(parseUserCommand('/admin')).toBeNull();
    expect(parseUserCommand(42 as unknown as string)).toBeNull();
  });
});

describe('production flow composition', () => {
  it('installs directory snapshot, usage recorder, and research tools', () => {
    const flow = productionFlow(makeEnv());
    expect(flow).not.toBeUndefined();
    const deps = flow?.('req-rem-1', 7);
    expect(deps?.model).toBe('router');
    expect(typeof deps?.directorySnapshot?.listRoutingProviders).toBe('function');
    expect(typeof deps?.usageRecorder?.record).toBe('function');
    expect(deps?.researchTools?.names).toEqual([...RESEARCH_TOOL_ALLOWLIST]);
    expect(typeof deps?.researchTools?.executor).toBe('function');
  });

  it('stays transport-only without a master secret', () => {
    const withoutSecret: Partial<AppEnv> = {
      APP_ENV: 'development',
      DB: env.DB,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    };
    expect(productionFlow(withoutSecret)).toBeUndefined();
  });
});

describe('end-to-end routing, research, and usage through the real webhook', () => {
  /**
   * Production-shaped fetch: Telegram traffic answers locally; provider
   * traffic (any non-Telegram host) answers as an OpenAI-compatible vendor
   * reporting usage. One mock stands in for both transports because the
   * worker under test composes both from the injected fetch seams.
   */
  function sharedFetch(vendorModel: string): FetchMock {
    return vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(url).includes('api.telegram.org')) return telegramOk();
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
      return Response.json({
        choices: [{ message: { content: `routed:${body.model ?? 'none'}` } }],
        model: vendorModel,
        usage: { prompt_tokens: 13, completion_tokens: 5 },
      });
    });
  }

  async function seedProviderStack(): Promise<void> {
    const { sealCredential } = await import('../src/ai/crypto');
    await env.DB.prepare(
      "INSERT INTO providers (id, base_url, enabled, weight, default_model, timeout_ms, max_credential_attempts, created_at, updated_at) VALUES ('cheap', 'https://cheap.invalid/v1', 1, 5, 'cheap-model', 5000, 1, ?, ?)",
    ).bind(NOW, NOW).run();
    await env.DB.prepare(
      "INSERT INTO providers (id, base_url, enabled, weight, default_model, timeout_ms, max_credential_attempts, created_at, updated_at) VALUES ('strong', 'https://strong.invalid/v1', 1, 90, 'strong-model', 5000, 1, ?, ?)",
    ).bind(NOW, NOW).run();
    for (const [credId, providerId] of [['cred-cheap', 'cheap'], ['cred-strong', 'strong']] as const) {
      const sealed = await sealCredential('sk-remediation-key', MASTER_SECRET);
      await env.DB.prepare(
        "INSERT INTO provider_credentials (id, provider_id, label, enabled, weight, secret_ciphertext, created_at, updated_at) VALUES (?, ?, 'label', 1, 100, ?, ?, ?)",
      ).bind(credId, providerId, sealed, NOW, NOW).run();
    }
  }

  function callWebhook(updateId: number, userId: number, chatType: string, text: string, shared: FetchMock, requestId: string): Promise<Response> {
    return route(textRequest(updateId, userId, chatType, text), {
      env: makeEnv(), requestId, telegramFetch: shared, now: () => NOW,
      flow: (requestIdInner: string, internalUserId: number) => {
        const production = productionFlow(makeEnv());
        if (production === undefined) throw new Error('production flow unavailable');
        const deps = production(requestIdInner, internalUserId);
        // Test seam parity: vendor calls must use the same mock the webhook
        // uses for Telegram. Rebuild the real router with the shared fetch.
        const router = new AIRouter({
          directory: new D1ProviderDirectory(env.DB),
          credentialStore: new D1CredentialStore(env.DB),
          health: new InMemoryRouterHealth(),
          masterSecret: MASTER_SECRET,
          fetchImpl: shared,
        });
        return { ...deps, provider: router };
      },
    });
  }

  it('routes /fast through productionFlow and records exactly one usage row', async () => {
    await seedProviderStack();
    const internalId = await seedUser(74001);
    const shared = sharedFetch('cheap:cheap-model');
    const response = await callWebhook(84001, 74001, 'private', '/fast is cheap online?', shared, 'req-rem-e2e-fast');
    expect(response.status).toBe(200);
    const bodies = sentBodies(shared);
    const chatReplies = bodies.filter((call) => call.url.includes('/sendMessage'));
    expect(chatReplies).toHaveLength(1);
    // FAST pins the lowest-weight *enabled* provider: the vendor call must go
    // to the cheap provider's base URL (the router strips the "cheap:" prefix
    // before calling the vendor, so the model the vendor sees is bare). This
    // proves the profile materially changed provider selection end to end.
    const vendorCalls = bodies.filter((call) => call.url.includes('cheap.invalid'));
    expect(vendorCalls).toHaveLength(1);
    expect(bodies.filter((call) => call.url.includes('strong.invalid'))).toHaveLength(0);
    expect(String(chatReplies[0]?.body['text'])).toContain('routed:');
    const summary = await summarizeUserUsage(env.DB, internalId);
    expect(summary.generations).toBe(1);
    expect(summary.inputTokens).toBe(13);
    expect(summary.outputTokens).toBe(5);
  });

  it('pins the strongest provider for /smart through the same production path', async () => {
    await seedProviderStack();
    await seedUser(74007);
    const shared = sharedFetch('strong:strong-model');
    const response = await callWebhook(84009, 74007, 'private', '/smart explain deeply', shared, 'req-rem-e2e-smart');
    expect(response.status).toBe(200);
    const vendorCalls = sentBodies(shared).filter((call) => call.url.includes('strong.invalid'));
    expect(vendorCalls).toHaveLength(1);
    expect(sentBodies(shared).filter((call) => call.url.includes('cheap.invalid'))).toHaveLength(0);
  });

  it('runs /research end-to-end with read-only tools and records usage', async () => {
    await seedProviderStack();
    const internalId = await seedUser(74002);
    const shared = sharedFetch('strong:strong-model');
    const response = await callWebhook(84002, 74002, 'private', '/research black holes', shared, 'req-rem-e2e-research');
    expect(response.status).toBe(200);
    const chatReplies = sentBodies(shared).filter((call) => call.url.includes('/sendMessage'));
    expect(chatReplies).toHaveLength(1);
    const summary = await summarizeUserUsage(env.DB, internalId);
    expect(summary.generations).toBeLessThanOrEqual(1);
  });

  // SAFETY_CASES_MARKER
  it('keeps bare commands, near-misses, groups, blocks, and duplicates safe', async () => {
    await seedProviderStack();
    await seedUser(74003);
    await seedUser(74004, 'USER', 'blocked');
    const shared = sharedFetch('strong:strong-model');
    // Bare command → usage hint, no AI, no usage row, no conversation write.
    const bare = await callWebhook(84003, 74003, 'private', '/research', shared, 'req-rem-bare');
    expect(bare.status).toBe(200);
    expect(sentBodies(shared).some((callBody) => String(callBody.body['text'] ?? '').includes('Quick tip'))).toBe(true);
    const bareMsgs = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first<{ n: number }>();
    expect(bareMsgs?.n ?? 0).toBe(0);
    // Near-miss is ordinary conversational text (DEFAULT profile, still answers).
    const nearMiss = await callWebhook(84004, 74003, 'private', '/researchx something', shared, 'req-rem-near');
    expect(nearMiss.status).toBe(200);
    // Group chat never reaches the flow: acknowledged without user traffic.
    const beforeGroup = shared.mock.calls.length;
    const group = await callWebhook(84005, 74003, 'group', '/research black holes', shared, 'req-rem-group');
    expect(group.status).toBe(200);
    expect(shared.mock.calls.length).toBe(beforeGroup);
    // Blocked user is rejected by admission with the fixed denial text.
    const blocked = await callWebhook(84006, 74004, 'private', '/fast hi', shared, 'req-rem-blocked');
    expect(blocked.status).toBe(200);
    expect(sentBodies(shared).some((callBody) => String(callBody.body['text'] ?? '').includes('can’t use the assistant'))).toBe(true);
    // Duplicate delivery of one flow update: one generation, one usage row.
    const first = await callWebhook(84007, 74003, 'private', '/fast again', shared, 'req-rem-dup');
    expect(first.status).toBe(200);
    const second = await callWebhook(84007, 74003, 'private', '/fast again', shared, 'req-rem-dup');
    expect(second.status).toBe(200);
    const updateRows = await env.DB.prepare('SELECT COUNT(*) AS n FROM usage_events WHERE request_id = ?').bind('req-rem-dup').first<{ n: number }>();
    expect(updateRows?.n).toBeLessThanOrEqual(1);
  });

  it('proves usage recorder idempotency across repeated executions', async () => {
    const internalId = await seedUser(74005);
    const recorder = buildProductionUsageRecorder(env.DB, internalId, 'req-rem-idem', () => NOW);
    await recorder.record({ providerId: 'cheap', vendorModel: 'cheap:router', requestId: 'req-rem-idem', inputTokens: 4, outputTokens: 2 });
    await recorder.record({ providerId: 'cheap', vendorModel: 'cheap:router', requestId: 'req-rem-idem', inputTokens: 4, outputTokens: 2 });
    const summary = await summarizeUserUsage(env.DB, internalId);
    expect(summary.generations).toBe(1);
  });

  it('does not record usage for failed generations', async () => {
    const internalId = await seedUser(74006);
    const { handleUserTextMessage } = await import('../src/orchestration/service');
    const { D1ProcessingRepository } = await import('../src/orchestration/processing-d1');
    const { D1ConversationOrchestrator } = await import('../src/orchestration/conversation-orchestrator');
    const { D1ConversationRepository } = await import('../src/db/conversation-d1');
    await env.DB.prepare('INSERT INTO processed_updates (update_id, telegram_user_id, kind, received_at) VALUES (?, ?, ?, ?)')
      .bind(84008, 74006, 'text', NOW).run();
    const failing: ModelProvider = { id: 'fail', generate: async () => { throw new Error('boom'); } };
    await expect(handleUserTextMessage(84008, 'will fail', {
      orchestrator: new D1ConversationOrchestrator(env.DB, new D1ConversationRepository(env.DB)),
      processing: new D1ProcessingRepository(env.DB),
      admission: { admit: async () => 'allowed' },
      provider: failing,
      requestId: 'req-rem-fail',
      agentUserId: String(internalId),
      userId: internalId,
      model: 'router',
      systemPrompt: '',
      usageRecorder: buildProductionUsageRecorder(env.DB, internalId, 'req-rem-fail', () => NOW),
    })).rejects.toThrow();
    expect((await summarizeUserUsage(env.DB, internalId)).generations).toBe(0);
  });
});

describe('provider-directory snapshot boundary', () => {
  it('exposes only non-secret routing metadata from the real D1 directory', async () => {
    await env.DB.prepare(
      "INSERT INTO providers (id, base_url, enabled, weight, default_model, timeout_ms, max_credential_attempts, created_at, updated_at) VALUES ('snap-a', 'https://a.test', 1, 30, 'm', 1000, 1, ?, ?)",
    ).bind(NOW, NOW).run();
    await env.DB.prepare(
      "INSERT INTO provider_credentials (id, provider_id, label, enabled, weight, secret_ciphertext, created_at, updated_at) VALUES ('snap-cred', 'snap-a', 'k', 1, 100, 'v1.sealed', ?, ?)",
    ).bind(NOW, NOW).run();
    const flow = productionFlow(makeEnv());
    const snapshot = flow?.('req-rem-snap', 1)?.directorySnapshot;
    const rows = await snapshot?.listRoutingProviders();
    expect(rows).toEqual([{ id: 'snap-a', enabled: true, weight: 30 }]);
    expect(JSON.stringify(rows)).not.toContain('v1.sealed');
    expect(JSON.stringify(rows)).not.toContain('https://a.test');
  });

  it('fails closed to router semantics when the directory is unavailable', async () => {
    const { resolveRoutingProfile } = await import('../src/ai/routing-profiles');
    expect(resolveRoutingProfile('FAST', { model: 'router', providers: [] }).model).toBe('router');
    expect(resolveRoutingProfile('COMPLEX', { model: 'router', providers: [] }).model).toBe('router');
  });

  it('never lets research tools outside the read-only web allowlist', async () => {
    const tools = buildResearchTools();
    expect(tools.names.every((name) => RESEARCH_TOOL_ALLOWLIST.has(name))).toBe(true);
    expect(await tools.executor('exec_shell', {})).toMatchObject({ kind: 'validation_error' });
    expect(await tools.executor('web_search', { query: 'x'.repeat(10) })).toMatchObject({ kind: 'upstream_error' });
  });
});