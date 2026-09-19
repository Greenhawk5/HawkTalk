import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { handleUserTextMessage } from '../src/orchestration/service';
import { D1ProcessingRepository } from '../src/orchestration/processing-d1';
import { D1ConversationOrchestrator } from '../src/orchestration/conversation-orchestrator';
import { D1ConversationRepository } from '../src/db/conversation-d1';
import type { ConversationFlowDeps } from '../src/orchestration/service';
import type { ModelProvider, ProviderGenerateInput, ProviderGenerateResult } from '../src/agent/provider';
import { recordUsageEvent, summarizeUserUsage } from '../src/db/usage';
import { renderMemoryContext } from '../src/memory/service';

const NOW = '2026-09-18T00:00:00.000Z';

let orchestrator: D1ConversationOrchestrator;
let processing: D1ProcessingRepository;

beforeEach(() => {
  orchestrator = new D1ConversationOrchestrator(env.DB, new D1ConversationRepository(env.DB));
  processing = new D1ProcessingRepository(env.DB);
});

async function seedUser(telegramUserId: number): Promise<number> {
  await env.DB.prepare(
    "INSERT INTO users (telegram_user_id, username, display_name, status, created_at, updated_at, last_seen) VALUES (?, ?, ?, 'active', ?, ?, ?)",
  )
    .bind(telegramUserId, `u${telegramUserId}`, `User ${telegramUserId}`, NOW, NOW, NOW)
    .run();
  const row = await env.DB.prepare('SELECT id FROM users WHERE telegram_user_id = ?').bind(telegramUserId).first<{ id: number }>();
  return row?.id ?? 0;
}

async function claimUpdateFor(updateId: number, telegramUserId: number): Promise<void> {
  await env.DB.prepare('INSERT INTO processed_updates (update_id, telegram_user_id, kind, received_at) VALUES (?, ?, ?, ?)')
    .bind(updateId, telegramUserId, 'text', NOW)
    .run();
}

function usageProvider(): ModelProvider {
  return {
    id: 'fake-provider',
    generate: vi.fn(async (input: ProviderGenerateInput): Promise<ProviderGenerateResult> => ({
      text: `echo:${[...input.messages].reverse().find((message) => message.role === 'user')?.content ?? ''}`,
      model: 'acme:usage-model',
      usage: { inputTokens: 11, outputTokens: 7 },
    })),
  };
}

function makeDeps(userId: number, overrides: Partial<ConversationFlowDeps> = {}): ConversationFlowDeps {
  return {
    orchestrator,
    processing,
    admission: { admit: async () => 'allowed' },
    provider: usageProvider(),
    requestId: 'req-phase10-flow',
    agentUserId: String(userId),
    userId,
    model: 'router',
    systemPrompt: 'You are HawkTalk.',
    ...overrides,
  };
}

describe('Phase 10 orchestration integration', () => {
  it('rewrites bare models through the routing profile without changing behavior', async () => {
    const userId = await seedUser(72001);
    await claimUpdateFor(72001, 72001);
    const provider = usageProvider();
    const deps = makeDeps(userId, { provider, routingProfile: 'FAST' });
    const result = await handleUserTextMessage(72001, 'hello profile', deps);
    expect(result.state).toBe('completed');
    expect(result.assistantText).toBe('echo:hello profile');
    expect((provider.generate as Mock).mock.calls[0]?.[0]?.model).toBe('router');
  });

  it('records successful generations into the owner-scoped usage ledger', async () => {
    const userId = await seedUser(72002);
    await claimUpdateFor(72002, 72002);
    const deps = makeDeps(userId, {
      usageRecorder: {
        record: async (input) => {
          await recordUsageEvent(env.DB, { id: `flow-${input.requestId}`, userId, providerId: input.providerId, vendorModel: input.vendorModel, requestId: input.requestId, inputTokens: input.inputTokens, outputTokens: input.outputTokens, createdAt: NOW });
        },
      },
    });
    const result = await handleUserTextMessage(72002, 'count my tokens', deps);
    expect(result.state).toBe('completed');
    const summary = await summarizeUserUsage(env.DB, userId);
    expect(summary).toEqual({ generations: 1, inputTokens: 11, outputTokens: 7, estimatedCostMicrodollars: 0 });
  });

  it('injects bounded recalled memory into context as untrusted data', async () => {
    const userId = await seedUser(72003);
    await claimUpdateFor(72003, 72003);
    const provider = usageProvider();
    const deps = makeDeps(userId, {
      provider,
      memoryRecall: async (query: string) => renderMemoryContext([{ fact: `user fact about ${query.slice(0, 20)}`, score: 0.9 }]),
    });
    const result = await handleUserTextMessage(72003, 'what do you remember?', deps);
    expect(result.state).toBe('completed');
    const sent = (provider.generate as Mock).mock.calls[0]?.[0] as ProviderGenerateInput;
    const lastUser = [...sent.messages].reverse().find((message) => message.role === 'user');
    expect(lastUser?.content).toContain('<untrusted_memory>');
  });

  it('runs research mode through the read-only tool loop and still completes', async () => {
    const userId = await seedUser(72004);
    await claimUpdateFor(72004, 72004);
    const provider: ModelProvider = {
      id: 'research-fake',
      generate: vi.fn(async (): Promise<ProviderGenerateResult> => ({
        text: 'researched answer',
        model: 'acme:research-model',
      })),
    };
    const deps = makeDeps(userId, {
      provider,
      routingProfile: 'RESEARCH',
      researchTools: {
        names: ['web_search', 'web_fetch', 'exec_shell'],
        executor: async () => ({ kind: 'success', content: 'tool output' }),
      },
    });
    const result = await handleUserTextMessage(72004, 'research black holes', deps);
    expect(result.state).toBe('completed');
    expect(result.assistantText).toBe('researched answer');
  });

  it('stays green without any Phase 10 hooks (pure Phase 6 behavior)', async () => {
    const userId = await seedUser(72005);
    await claimUpdateFor(72005, 72005);
    const result = await handleUserTextMessage(72005, 'plain hello', makeDeps(userId));
    expect(result.state).toBe('completed');
    expect(result.assistantText).toBe('echo:plain hello');
    expect((await summarizeUserUsage(env.DB, userId)).generations).toBe(0);
  });
});