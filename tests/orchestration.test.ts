import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { D1ConversationOrchestrator } from '../src/orchestration/conversation-orchestrator';
import { D1ProcessingRepository } from '../src/orchestration/processing-d1';
import { handleUserTextMessage, getCompletedAssistantText } from '../src/orchestration/service';
import type { ConversationFlowDeps } from '../src/orchestration/service';
import { D1ConversationRepository } from '../src/db/conversation-d1';
import type { ConversationRepository } from '../src/db/conversation-repository';
import { findInternalUserIdByTelegramId } from '../src/db/users';
import { sealCredential } from '../src/ai/crypto';
import { AIRouter, InMemoryRouterHealth, StaticProviderDirectory } from '../src/ai/router';
import { StaticCredentialStore } from '../src/ai/credentials';
import type { ModelProvider, ProviderGenerateInput, ProviderGenerateResult } from '../src/agent/provider';

const NOW = '2026-09-17T12:00:00.000Z';

let repo: ConversationRepository;
let orchestrator: D1ConversationOrchestrator;
let processing: D1ProcessingRepository;

beforeEach(() => {
  repo = new D1ConversationRepository(env.DB);
  processing = new D1ProcessingRepository(env.DB);
  orchestrator = new D1ConversationOrchestrator(env.DB, repo);
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

function echoProvider(): ModelProvider {
  return {
    id: 'fake-provider',
    generate: vi.fn(async (input: ProviderGenerateInput): Promise<ProviderGenerateResult> => ({
      text: `echo:${[...input.messages].reverse().find((message) => message.role === 'user')?.content ?? ''}`,
      model: 'fake-model',
    })),
  };
}

function makeDeps(overrides: Partial<ConversationFlowDeps> = {}): ConversationFlowDeps {
  return {
    orchestrator,
    processing,
    admission: { admit: async () => 'allowed' },
    provider: echoProvider(),
    requestId: 'req-orchestration-test',
    agentUserId: '0',
    userId: 0,
    model: 'router',
    systemPrompt: 'You are HawkTalk.',
    ...overrides,
  };
}

function generate(provider: ModelProvider): Mock {
  return (provider as unknown as { generate: Mock }).generate;
}

describe('Phase 6 default conversation resolution', () => {
  it('creates a default conversation on first resolution', async () => {
    const userId = await seedUser(7001);
    const resolution = await orchestrator.resolveDefaultConversation(userId);
    expect(resolution.created).toBe(true);
    expect(resolution.conversation.user_id).toBe(userId);
    expect(resolution.conversation.status).toBe('active');
  });

  it('reuses the same conversation on subsequent resolutions', async () => {
    const userId = await seedUser(7002);
    const first = await orchestrator.resolveDefaultConversation(userId);
    const second = await orchestrator.resolveDefaultConversation(userId);
    expect(second.created).toBe(false);
    expect(second.conversation.id).toBe(first.conversation.id);
    const rows = await env.DB.prepare('SELECT COUNT(*) AS count FROM conversations WHERE user_id = ?').bind(userId).first<{ count: number }>();
    expect(rows?.count).toBe(1);
  });

  it('creates a replacement when the default is archived and leaves the archive intact', async () => {
    const userId = await seedUser(7003);
    const first = await orchestrator.resolveDefaultConversation(userId);
    await orchestrator.appendMessage(userId, first.conversation.id, { role: 'user', content: 'pre-archive' });
    await env.DB.prepare("UPDATE conversations SET status = 'archived' WHERE id = ?").bind(first.conversation.id).run();
    const second = await orchestrator.resolveDefaultConversation(userId);
    expect(second.created).toBe(true);
    expect(second.conversation.id).not.toBe(first.conversation.id);
    expect(second.conversation.status).toBe('active');
    const archived = await env.DB.prepare('SELECT status FROM conversations WHERE id = ?').bind(first.conversation.id).first<{ status: string }>();
    expect(archived?.status).toBe('archived');
  });

  it('keeps default conversations isolated between users', async () => {
    const userA = await seedUser(7004);
    const userB = await seedUser(7005);
    const a = await orchestrator.resolveDefaultConversation(userA);
    const b = await orchestrator.resolveDefaultConversation(userB);
    expect(a.conversation.id).not.toBe(b.conversation.id);
    expect(a.conversation.user_id).toBe(userA);
    expect(b.conversation.user_id).toBe(userB);
    // User B cannot append to or read A's conversation.
    await expect(orchestrator.appendMessage(userB, a.conversation.id, { role: 'user', content: 'intrusion' })).rejects.toThrow();
    await expect(orchestrator.getContext(userB, a.conversation.id, 10)).resolves.toEqual([]);
  });

  it('handles concurrent resolution with exactly one default mapping', async () => {
    const userId = await seedUser(7006);
    const results = await Promise.all(Array.from({ length: 4 }, () => orchestrator.resolveDefaultConversation(userId)));
    const mappings = await env.DB.prepare('SELECT COUNT(*) AS count FROM default_conversations WHERE user_id = ?').bind(userId).first<{ count: number }>();
    expect(mappings?.count).toBe(1);
    for (const result of results) {
      expect(result.conversation.status).toBe('active');
      expect(result.conversation.user_id).toBe(userId);
    }
  });
});

describe('Phase 6 conversational flow', () => {
  it('runs the full end-to-end flow: persist user message, generate, persist assistant', async () => {
    const userId = await seedUser(7101);
    await claimUpdateFor(7101, 7101);
    const deps = makeDeps({ userId, agentUserId: String(userId), requestId: 'req-e2e' });
    const result = await handleUserTextMessage(7101, 'hello world', deps);
    expect(result.state).toBe('completed');
    expect(result.assistantText).toBe('echo:hello world');
    expect(generate(deps.provider)).toHaveBeenCalledTimes(1);

    const record = await processing.getProcessingRecord(7101);
    expect(record?.state).toBe('completed');
    expect(record?.assistantMessageId).not.toBeNull();

    const messages = await env.DB.prepare('SELECT role, content FROM messages ORDER BY seq ASC').all<{ role: string; content: string }>();
    expect(messages.results.map((row) => row.role)).toEqual(['user', 'assistant']);
    expect(messages.results[0]?.content).toBe('hello world');
    expect(messages.results[1]?.content).toBe('echo:hello world');
  });

  it('passes bounded history to the provider with the user message last', async () => {
    const userId = await seedUser(7102);
    await claimUpdateFor(7102, 7102);
    const { conversation } = await orchestrator.resolveDefaultConversation(userId);
    await orchestrator.appendMessage(userId, conversation.id, { role: 'user', content: 'earlier question' });
    await orchestrator.appendMessage(userId, conversation.id, { role: 'assistant', content: 'earlier answer' });
    const provider = echoProvider();
    const deps = makeDeps({ userId, provider });
    await handleUserTextMessage(7102, 'first question', deps);
    const input = generate(provider).mock.calls[0]?.[0] as ProviderGenerateInput;
    expect(input.messages.at(-1)?.content).toBe('first question');
    expect(input.messages.at(-1)?.role).toBe('user');
    // Engine prepends the system prompt; history follows oldest-first.
    expect(input.messages[0]?.role).toBe('system');
    expect(input.messages[1]?.content).toBe('earlier question');
    expect(input.systemPrompt).toBe('You are HawkTalk.');
    expect(input.requestId).toBe(deps.requestId);
  });

  it('marks generating durably before invoking the provider', async () => {
    const userId = await seedUser(7103);
    await claimUpdateFor(7103, 7103);
    let sawStateDuringGenerate: string | null = null;
    const provider: ModelProvider = {
      id: 'probe',
      generate: async () => {
        const record = await processing.getProcessingRecord(7103);
        sawStateDuringGenerate = record?.state ?? null;
        return { text: 'answer', model: 'm' };
      },
    };
    await handleUserTextMessage(7103, 'probe', makeDeps({ userId, provider }));
    expect(sawStateDuringGenerate).toBe('generating');
  });

  it('persists only one user message when the same update is processed concurrently', async () => {
    const userId = await seedUser(7104);
    await claimUpdateFor(7104, 7104);
    const provider = echoProvider();
    const deps = () => makeDeps({ userId, provider });
    const results = await Promise.allSettled([
      handleUserTextMessage(7104, 'once', deps()),
      handleUserTextMessage(7104, 'once', deps()),
      handleUserTextMessage(7104, 'once', deps()),
    ]);
    // Exactly one invocation wins generation; losers either reuse the durable
    // result or fail closed — never a second AI call or duplicate rows.
    const fulfilled = results.filter((result) => result.status === 'fulfilled') as Array<PromiseFulfilledResult<{ state: string; assistantText: string }>>;
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const result of fulfilled) expect(['completed', 'reused']).toContain(result.value.state);
    const userMessages = await env.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE role = 'user'").first<{ count: number }>();
    expect(userMessages?.count).toBe(1);
    const assistantMessages = await env.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE role = 'assistant'").first<{ count: number }>();
    expect(assistantMessages?.count).toBe(1);
    expect(generate(provider).mock.calls.length).toBe(1);
  });

  it('never invokes the provider when markGenerating loses the race to a generating state', async () => {
    const userId = await seedUser(7105);
    await claimUpdateFor(7105, 7105);
    await env.DB.prepare("UPDATE processed_updates SET processing_state = 'generating' WHERE update_id = 7105").run();
    const provider = echoProvider();
    await expect(handleUserTextMessage(7105, 'raced', makeDeps({ userId, provider }))).rejects.toMatchObject({ kind: 'generating_mark_failed' });
    expect(generate(provider)).not.toHaveBeenCalled();
  });

  it('marks failed terminally on AI failure and never regenerates on redelivery', async () => {
    const userId = await seedUser(7106);
    await claimUpdateFor(7106, 7106);
    const provider: ModelProvider = {
      id: 'failing',
      generate: vi.fn(async () => {
        throw new Error('provider exploded');
      }),
    };
    await expect(handleUserTextMessage(7106, 'doomed', makeDeps({ userId, provider }))).rejects.toMatchObject({ kind: 'agent_failed' });
    expect(generate(provider)).toHaveBeenCalledTimes(1);
    expect(await processing.getProcessingRecord(7106)).toMatchObject({ state: 'failed' });
    // Redelivery reuse path: terminal failure returns null; AI stays at 1 call.
    expect(await getCompletedAssistantText(7106, makeDeps({ userId }))).toBeNull();
    expect(generate(provider)).toHaveBeenCalledTimes(1);
  });

  it('reuses the persisted assistant text for a completed update without calling the AI', async () => {
    const userId = await seedUser(7107);
    await claimUpdateFor(7107, 7107);
    const provider = echoProvider();
    const first = await handleUserTextMessage(7107, 'persist me', makeDeps({ userId, provider }));
    expect(first.state).toBe('completed');
    const callsAfterFirst = generate(provider).mock.calls.length;
    expect(await getCompletedAssistantText(7107, makeDeps({ userId }))).toBe(first.assistantText);
    expect(generate(provider)).toHaveBeenCalledTimes(callsAfterFirst);
  });

  it('keeps conversation history bounded in the provider request', async () => {
    const userId = await seedUser(7108);
    await claimUpdateFor(7108, 7108);
    const { conversation } = await orchestrator.resolveDefaultConversation(userId);
    for (let i = 0; i < 30; i += 1) {
      await orchestrator.appendMessage(userId, conversation.id, { role: 'user', content: `msg-${i}` });
      await orchestrator.appendMessage(userId, conversation.id, { role: 'assistant', content: `reply-${i}` });
    }
    const provider = echoProvider();
    await handleUserTextMessage(7108, 'new question', makeDeps({ userId, provider }));
    const input = generate(provider).mock.calls[0]?.[0] as ProviderGenerateInput;
    expect(input.messages.length).toBeLessThanOrEqual(21);
    expect(input.messages.at(-1)?.content).toBe('new question');
  });

  it('isolates users: another user cannot read or reuse a foreign update result', async () => {
    const userId = await seedUser(7109);
    const other = await seedUser(7110);
    await claimUpdateFor(7109, 7109);
    await handleUserTextMessage(7109, 'private', makeDeps({ userId }));
    expect(await getCompletedAssistantText(7109, makeDeps({ userId: other }))).toBeNull();
    expect(await getCompletedAssistantText(7109, makeDeps({ userId }))).toBe('echo:private');
  });

  it('resolves internal users by Telegram id owner-scoped', async () => {
    const userId = await seedUser(7111);
    expect(await findInternalUserIdByTelegramId(env.DB, 7111)).toBe(userId);
    expect(await findInternalUserIdByTelegramId(env.DB, 424242)).toBeNull();
  });
});

describe('Phase 6 router integration (production path, sealed credentials)', () => {
  it('routes through the real AIRouter to a working provider and persists the reply', async () => {
    const userId = await seedUser(7201);
    await claimUpdateFor(7201, 7201);
    const masterSecret = 'integration-master-secret';
    const sealed = await sealCredential('sk-integration-key', masterSecret);
    const router = new AIRouter({
      directory: new StaticProviderDirectory([
        { id: 'mockai', baseUrl: 'https://mockai.invalid/v1', weight: 100, defaultModel: 'mock-1', timeoutMs: 5000, maxCredentialAttempts: 1 },
      ]),
      credentialStore: new StaticCredentialStore([
        { id: 'cred-1', providerId: 'mockai', label: 'k', enabled: true, weight: 100, ciphertext: sealed },
      ]),
      health: new InMemoryRouterHealth(),
      masterSecret,
      fetchImpl: vi.fn(async (): Promise<Response> => Response.json({ choices: [{ message: { content: 'routed reply' } }], model: 'mock-1' })),
    });
    const deps = makeDeps({ userId, provider: router, model: 'router' });
    const result = await handleUserTextMessage(7201, 'via router', deps);
    expect(result.assistantText).toBe('routed reply');
    expect(result.state).toBe('completed');
    expect(await processing.getProcessingRecord(7201)).toMatchObject({ state: 'completed' });
  });

  it('marks the update failed terminally when the router exhausts all providers', async () => {
    const userId = await seedUser(7202);
    await claimUpdateFor(7202, 7202);
    const masterSecret = 'integration-master-secret';
    const sealed = await sealCredential('sk-integration-key', masterSecret);
    const router = new AIRouter({
      directory: new StaticProviderDirectory([
        { id: 'downai', baseUrl: 'https://downai.invalid/v1', weight: 100, defaultModel: 'd-1', timeoutMs: 5000, maxCredentialAttempts: 1 },
      ]),
      credentialStore: new StaticCredentialStore([
        { id: 'cred-d', providerId: 'downai', label: 'k', enabled: true, weight: 100, ciphertext: sealed },
      ]),
      health: new InMemoryRouterHealth(),
      masterSecret,
      fetchImpl: vi.fn(async (): Promise<Response> => new Response('server error', { status: 500 })),
    });
    await expect(handleUserTextMessage(7202, 'nothing works', makeDeps({ userId, provider: router }))).rejects.toMatchObject({ kind: 'agent_failed' });
    expect(await processing.getProcessingRecord(7202)).toMatchObject({ state: 'failed' });
  });
});

describe('Phase 6 processing state machine', () => {
  it('enforces state transitions atomically', async () => {
    await claimUpdateFor(7300, 7300);
    expect(await processing.markGenerating(7300, 'conv-1')).toBe(true);
    expect(await processing.markGenerating(7300, 'conv-2')).toBe(false);
    expect(await processing.completeWithAssistantMessage(7300, 'msg-1')).toBe(true);
    expect(await processing.completeWithAssistantMessage(7300, 'msg-2')).toBe(false);
    expect((await processing.getProcessingRecord(7300))?.state).toBe('completed');
  });

  it('keeps unknown updates unmarkable', async () => {
    expect(await processing.markGenerating(99999999, 'nope')).toBe(false);
    expect(await processing.completeWithAssistantMessage(99999999, 'nope')).toBe(false);
    expect(await processing.markFailed(99999999)).toBe(false);
  });
});
