import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestClock } from '../src/conversation/clock';
import { D1ConversationRepository } from '../src/db/conversation-d1';
import type { ConversationRepository } from '../src/db/conversation-repository';
import type { ConversationRow, MessageRow } from '../src/db/conversation-types';
import {
  ConversationService,
  ConversationServiceError,
  MAX_HISTORY_MESSAGES,
  MAX_HISTORY_MESSAGE_CHARS,
  MAX_HISTORY_TOTAL_CHARS,
} from '../src/conversation/service';

let repo: ConversationRepository;

beforeEach(async () => {
  repo = new D1ConversationRepository(env.DB);
});

const NOW = '2026-09-17T12:00:00.000Z';

function service(): ConversationService {
  return new ConversationService(repo);
}

async function seedUser(telegramUserId: number): Promise<number> {
  const result = await env.DB.prepare(
    "INSERT INTO users (telegram_user_id, username, display_name, status, created_at, updated_at, last_seen) VALUES (?, ?, ?, 'active', ?, ?, ?)",
  )
    .bind(telegramUserId, `u${telegramUserId}`, `User ${telegramUserId}`, NOW, NOW, NOW)
    .run();
  const row = await env.DB.prepare('SELECT id FROM users WHERE telegram_user_id = ?').bind(telegramUserId).first<{ id: number }>();
  void result;
  return row?.id ?? 0;
}

async function seedConversation(userId: number): Promise<ConversationRow> {
  const row = await env.DB.prepare(
    "INSERT INTO conversations (id, user_id, title, status, created_at, updated_at) VALUES (?, ?, 'seed', 'active', ?, ?)",
  )
    .bind(crypto.randomUUID(), userId, NOW, NOW)
    .run();
  void row;
  const conversation = await env.DB.prepare('SELECT * FROM conversations WHERE user_id = ?').bind(userId).first<ConversationRow>();
  expect(conversation).not.toBeNull();
  return conversation as ConversationRow;
}

describe('Phase 5 schema constraints', () => {
  it('scopes every repository statement by owner user id', async () => {
    const owner = await seedUser(1001);
    const attacker = await seedUser(1002);
    const conversation = await seedConversation(owner);
    const message = await repo.appendMessage(owner, conversation.id, { id: crypto.randomUUID(), role: 'user', content: 'mine' });
    expect(message).not.toBeNull();
    await expect(repo.getConversation(attacker, conversation.id)).resolves.toBeNull();
    await expect(repo.getConversationHistory(attacker, conversation.id, 10)).resolves.toEqual([]);
    await expect(repo.appendMessage(attacker, conversation.id, { id: crypto.randomUUID(), role: 'user', content: 'stolen' })).resolves.toBeNull();
    await expect(repo.renameConversation(attacker, conversation.id, 'hijack', NOW)).resolves.toBeNull();
    await expect(repo.archiveConversation(attacker, conversation.id, NOW)).resolves.toBeNull();
    await expect(repo.deleteConversation(attacker, conversation.id)).resolves.toBe(false);
    const ownMessageId = message?.id as string;
    await expect(repo.deleteMessage(attacker, conversation.id, ownMessageId)).resolves.toBe(false);
    const stillThere = await repo.getConversation(owner, conversation.id);
    expect(stillThere?.user_id).toBe(owner);
  });

  it('enforces role check constraint', async () => {
    const owner = await seedUser(1010);
    const conversation = await seedConversation(owner);
    await expect(
      env.DB.prepare('INSERT INTO messages (id, conversation_id, user_id, seq, role, content, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)')
        .bind(crypto.randomUUID(), conversation.id, owner, 'tool', 'x', NOW)
        .run(),
    ).rejects.toThrow();
  });

  it('enforces 36-char UUID shape constraints', async () => {
    const owner = await seedUser(1011);
    const conversation = await seedConversation(owner);
    await expect(
      env.DB.prepare('INSERT INTO messages (id, conversation_id, user_id, seq, role, content, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)')
        .bind('short-id', conversation.id, owner, 'user', 'x', NOW)
        .run(),
    ).rejects.toThrow();
  });

  it('enforces UNIQUE(conversation_id, seq) for deterministic ordering', async () => {
    const owner = await seedUser(1012);
    const conversation = await seedConversation(owner);
    const id1 = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO messages (id, conversation_id, user_id, seq, role, content, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)')
      .bind(id1, conversation.id, owner, 'user', 'first', NOW)
      .run();
    await expect(
      env.DB.prepare('INSERT INTO messages (id, conversation_id, user_id, seq, role, content, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)')
        .bind(crypto.randomUUID(), conversation.id, owner, 'assistant', 'second', NOW)
        .run(),
    ).rejects.toThrow();
  });

  it('cascades message deletion when a conversation is deleted', async () => {
    const owner = await seedUser(1013);
    const conversation = await seedConversation(owner);
    await repo.appendMessage(owner, conversation.id, { id: crypto.randomUUID(), role: 'user', content: 'hello' });
    await repo.deleteConversation(owner, conversation.id);
    const remaining = await env.DB.prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?').bind(conversation.id).first<{ count: number }>();
    expect(remaining?.count).toBe(0);
  });
});

describe('Phase 5 conversation lifecycle', () => {
  it('creates a conversation with a validated UUIDv4 id and detached row', async () => {
    const owner = await seedUser(2001);
    const conversation = await service().createConversation(owner, 'my chat');
    expect(conversation.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(conversation.title).toBe('my chat');
    expect(Object.isFrozen(conversation)).toBe(false);
  });

  it('rejects invalid titles and user ids', async () => {
    const owner = await seedUser(2002);
    await expect(service().createConversation(owner, '')).rejects.toThrow(ConversationServiceError);
    await expect(service().createConversation(owner, 'x'.repeat(201))).rejects.toThrow(ConversationServiceError);
    await expect(service().createConversation(-1, 'ok')).rejects.toThrow(ConversationServiceError);
    await expect(service().createConversation(1.5, 'ok')).rejects.toThrow(ConversationServiceError);
  });

  it('lists conversations newest-updated first, scoped to owner', async () => {
    const owner = await seedUser(2003);
    const other = await seedUser(2004);
    await service().createConversation(owner, 'first');
    await service().createConversation(other, 'foreign');
    await service().createConversation(owner, 'second');
    const list = await service().listConversations(owner, 10);
    expect(list).toHaveLength(2);
    expect(list.every((conversation) => conversation.user_id === owner)).toBe(true);
  });

  it('rejects list limits outside 1..100', async () => {
    const owner = await seedUser(2005);
    await expect(service().listConversations(owner, 0)).rejects.toThrow(ConversationServiceError);
    await expect(service().listConversations(owner, 101)).rejects.toThrow(ConversationServiceError);
    await expect(service().listConversations(owner, 1.5)).rejects.toThrow(ConversationServiceError);
  });

  it('renames only the owner conversation', async () => {
    const owner = await seedUser(2006);
    const conversation = await service().createConversation(owner, 'old');
    const updated = await service().renameConversation(owner, conversation.id, 'new');
    expect(updated.title).toBe('new');
  });

  it('archives and remains archived (Phase 5 one-way)', async () => {
    const owner = await seedUser(2007);
    const conversation = await service().createConversation(owner, 'chat');
    const archived = await service().archiveConversation(owner, conversation.id);
    expect(archived.status).toBe('archived');
    // Phase 5: no unarchive operation; status remains archived
    const stillArchived = await repo.getConversation(owner, conversation.id);
    expect(stillArchived?.status).toBe('archived');
  });

  it('returns not_found for unknown or foreign conversation ids', async () => {
    const owner = await seedUser(2008);
    const other = await seedUser(2009);
    const otherConversation = await service().createConversation(other, 'hidden');
    await expect(service().getConversation(owner, otherConversation.id)).rejects.toThrow(ConversationServiceError);
    await expect(service().getConversation(owner, crypto.randomUUID())).rejects.toThrow(ConversationServiceError);
  });

  it('deletes a conversation and cascades messages atomically', async () => {
    const owner = await seedUser(2009);
    const conversation = await service().createConversation(owner, 'gone');
    await service().appendMessage(owner, conversation.id, { role: 'user', content: 'hi' });
    const deleted = await service().deleteConversation(owner, conversation.id);
    expect(deleted).toBe(true);
    await expect(service().getConversation(owner, conversation.id)).rejects.toThrow(ConversationServiceError);
    const messages = await env.DB.prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?').bind(conversation.id).first<{ count: number }>();
    expect(messages?.count).toBe(0);
  });
});

describe('Phase 5 clock and archive regressions', () => {
  it('uses the runtime clock by default', async () => {
    const owner = await seedUser(2100);
    const before = Date.now();
    const conversation = await service().createConversation(owner, 'runtime');
    expect(Date.parse(conversation.created_at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(conversation.created_at)).toBeLessThanOrEqual(Date.now());
    expect(conversation.updated_at).toBe(conversation.created_at);
  });

  it('uses an injected clock consistently without caller timestamps', async () => {
    const owner = await seedUser(2101);
    const fixed = new ConversationService(repo, createTestClock(NOW));
    const conversation = await fixed.createConversation(owner, 'fixed');
    expect(conversation.created_at).toBe(NOW);
    expect(conversation.updated_at).toBe(NOW);
    const message = await fixed.appendMessage(owner, conversation.id, { role: 'user', content: 'fixed' });
    expect(message.created_at).toBe(NOW);
    expect((await fixed.renameConversation(owner, conversation.id, 'renamed')).updated_at).toBe(NOW);
    expect((await fixed.archiveConversation(owner, conversation.id)).updated_at).toBe(NOW);
  });

  it('rejects timestamp payload fields and ignores extra positional timestamps', async () => {
    const owner = await seedUser(2102);
    const fixed = new ConversationService(repo, createTestClock(NOW));
    for (const supplied of ['2000-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z']) {
      // @ts-expect-error Public callers cannot supply timestamps.
      const conversation = await fixed.createConversation(owner, 'fixed', supplied);
      expect(conversation.created_at).toBe(NOW);
      for (const field of ['now', 'timestamp', 'created_at']) {
        await expect(fixed.appendMessage(owner, conversation.id, { role: 'user', content: 'x', [field]: supplied }))
          .rejects.toMatchObject({ code: 'invalid_request' });
      }
      // @ts-expect-error Public callers cannot supply timestamps.
      const message = await fixed.appendMessage(owner, conversation.id, { role: 'user', content: 'x' }, supplied);
      expect(message.created_at).toBe(NOW);
      // @ts-expect-error Public callers cannot supply timestamps.
      const renamed = await fixed.renameConversation(owner, conversation.id, 'renamed', supplied);
      expect(renamed.updated_at).toBe(NOW);
      // @ts-expect-error Public callers cannot supply timestamps.
      const archived = await fixed.archiveConversation(owner, conversation.id, supplied);
      expect(archived.updated_at).toBe(NOW);
    }
  });

  it('keeps timestamps monotonic when the runtime clock moves backwards', async () => {
    const owner = await seedUser(2103);
    let current = NOW;
    const controlled = new ConversationService(repo, { now: () => current });
    const conversation = await controlled.createConversation(owner, 'clock');
    current = '2026-09-18T12:00:00.000Z';
    const first = await controlled.appendMessage(owner, conversation.id, { role: 'user', content: 'first' });
    current = '2026-09-16T12:00:00.000Z';
    const second = await controlled.appendMessage(owner, conversation.id, { role: 'assistant', content: 'second' });
    expect(second.seq).toBe(first.seq + 1);
    expect(second.created_at).toBe(first.created_at);
    expect((await controlled.renameConversation(owner, conversation.id, 'renamed')).updated_at).toBe(first.created_at);
    expect((await controlled.archiveConversation(owner, conversation.id)).updated_at).toBe(first.created_at);
  });

  it('keeps archive one-way through rename and rejects appends but allows deletion', async () => {
    const owner = await seedUser(2104);
    const fixed = new ConversationService(repo, createTestClock(NOW));
    const conversation = await fixed.createConversation(owner, 'archive');
    await fixed.appendMessage(owner, conversation.id, { role: 'user', content: 'kept' });
    expect((await fixed.archiveConversation(owner, conversation.id)).status).toBe('archived');
    expect((await fixed.renameConversation(owner, conversation.id, 'renamed')).status).toBe('archived');
    expect((await fixed.archiveConversation(owner, conversation.id)).status).toBe('archived');
    await expect(fixed.appendMessage(owner, conversation.id, { role: 'user', content: 'blocked' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(repo.appendMessage(owner, conversation.id, { id: crypto.randomUUID(), role: 'user', content: 'blocked' })).resolves.toBeNull();
    expect(repo).not.toHaveProperty('updateConversation');
    expect(repo).not.toHaveProperty('unarchiveConversation');
    expect(fixed).not.toHaveProperty('unarchiveConversation');
    expect(await fixed.deleteConversation(owner, conversation.id)).toBe(true);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?').bind(conversation.id).first('count')).toBe(0);
  });

  it('isolates all service operations from another owner', async () => {
    const owner = await seedUser(2105);
    const other = await seedUser(2106);
    const fixed = new ConversationService(repo, createTestClock(NOW));
    const conversation = await fixed.createConversation(owner, 'private');
    const message = await fixed.appendMessage(owner, conversation.id, { role: 'user', content: 'private' });
    await expect(fixed.getConversation(other, conversation.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(await fixed.listConversations(other, 100)).toEqual([]);
    expect(await fixed.getHistory(other, conversation.id, 100)).toEqual([]);
    expect(await fixed.getContext(other, conversation.id, 100)).toEqual([]);
    await expect(fixed.renameConversation(other, conversation.id, 'stolen')).rejects.toMatchObject({ code: 'not_found' });
    await expect(fixed.archiveConversation(other, conversation.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(fixed.appendMessage(other, conversation.id, { role: 'user', content: 'stolen' })).rejects.toMatchObject({ code: 'not_found' });
    expect(await fixed.deleteMessage(other, conversation.id, message.id)).toBe(false);
    expect(await fixed.deleteConversation(other, conversation.id)).toBe(false);
    expect((await fixed.getConversation(owner, conversation.id)).status).toBe('active');
    expect(await fixed.getContext(owner, conversation.id, 100)).toEqual([{ role: 'user', content: 'private' }]);
  });

  it('rejects metadata and emits no logs on successful or invalid operations', async () => {
    const logs = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const spies = logs.map((method) => vi.spyOn(console, method));
    const owner = await seedUser(2107);
    const fixed = new ConversationService(repo, createTestClock(NOW));
    const conversation = await fixed.createConversation(owner, 'opaque');
    for (const key of ['metadata', 'credentials', 'headers', 'telegramUpdate', 'providerResponse']) {
      await expect(fixed.appendMessage(owner, conversation.id, { role: 'user', content: 'opaque', [key]: 'synthetic marker' }))
        .rejects.toMatchObject({ code: 'invalid_request' });
    }
    await fixed.appendMessage(owner, conversation.id, { role: 'user', content: 'sk-synthetic-marker' });
    expect(await fixed.getContext(owner, conversation.id, 100)).toEqual([{ role: 'user', content: 'sk-synthetic-marker' }]);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('Phase 5 message append + history bounds', () => {
  it('appends messages with increasing gapless seq and one shared timestamp', async () => {
    const owner = await seedUser(3001);
    const conversation = await seedConversation(owner);
    const m1 = await repo.appendMessage(owner, conversation.id, { id: crypto.randomUUID(), role: 'user', content: 'one' });
    const m2 = await repo.appendMessage(owner, conversation.id, { id: crypto.randomUUID(), role: 'assistant', content: 'two' });
    expect(m1?.seq).toBe(1);
    expect(m2?.seq).toBe(2);
    const touched = await repo.getConversation(owner, conversation.id);
    expect(touched?.updated_at).not.toBeNull();
  });

  it('rejects invalid role or content on append', async () => {
    const owner = await seedUser(3002);
    const conversation = await seedConversation(owner);
    await expect(service().appendMessage(owner, conversation.id, { role: 'tool', content: 'x' })).rejects.toThrow(ConversationServiceError);
    await expect(service().appendMessage(owner, conversation.id, { role: 'user', content: '' })).rejects.toThrow(ConversationServiceError);
    await expect(
      service().appendMessage(owner, conversation.id, { role: 'user', content: 'x'.repeat(MAX_HISTORY_MESSAGE_CHARS + 1) }),
    ).rejects.toThrow(ConversationServiceError);
    await expect(service().appendMessage(owner, conversation.id, { role: 'user', content: 42 })).rejects.toThrow(ConversationServiceError);
  });

  it('returns not_found when appending to a foreign conversation', async () => {
    const owner = await seedUser(3003);
    const other = await seedUser(3004);
    const foreignConversation = await service().createConversation(other, 'hidden');
    await expect(service().appendMessage(owner, foreignConversation.id, { role: 'user', content: 'x' })).rejects.toThrow(ConversationServiceError);
  });

  it('keeps history as newest contiguous suffix within message count limit', async () => {
    const owner = await seedUser(3005);
    const conversation = await seedConversation(owner);
    const total = MAX_HISTORY_MESSAGES + 20;
    for (let i = 0; i < total; i += 1) {
      await repo.appendMessage(owner, conversation.id, { id: crypto.randomUUID(), role: 'user', content: `msg-${i}` });
    }
    const history = await service().getHistory(owner, conversation.id, MAX_HISTORY_MESSAGES);
    expect(history).toHaveLength(MAX_HISTORY_MESSAGES);
    expect(history[0]?.content).toBe(`msg-${total - MAX_HISTORY_MESSAGES}`);
    expect(history[MAX_HISTORY_MESSAGES - 1]?.content).toBe(`msg-${total - 1}`);
    const seqs = history.map((message) => message.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1 + (total - MAX_HISTORY_MESSAGES)));
  });

  it('truncates history at total character budget, newest suffix preserved', async () => {
    const owner = await seedUser(3006);
    const conversation = await seedConversation(owner);
    const big = 'a'.repeat(MAX_HISTORY_MESSAGE_CHARS);
    for (let i = 0; i < 6; i += 1) {
      await repo.appendMessage(owner, conversation.id, { id: crypto.randomUUID(), role: 'user', content: big });
    }
    const history = await service().getHistory(owner, conversation.id, MAX_HISTORY_MESSAGES);
    const totalChars = history.reduce((sum, message) => sum + message.content.length, 0);
    expect(totalChars).toBe(MAX_HISTORY_TOTAL_CHARS);
    expect(history.map((message) => message.seq)).toEqual([2, 3, 4, 5, 6]);
    expect(history[history.length - 1]?.content).toBe(big);
  });

  it('rejects history limits outside 1..100', async () => {
    const owner = await seedUser(3007);
    const conversation = await seedConversation(owner);
    await expect(service().getHistory(owner, conversation.id, 0)).rejects.toThrow(ConversationServiceError);
    await expect(service().getHistory(owner, conversation.id, MAX_HISTORY_MESSAGES + 1)).rejects.toThrow(ConversationServiceError);
  });
});

describe('Phase 5 concurrency', () => {
  it('serializes concurrent appends into unique gapless sequences', async () => {
    const owner = await seedUser(4001);
    const conversation = await seedConversation(owner);
    const writers = Array.from({ length: 8 }, () =>
      repo.appendMessage(owner, conversation.id, { id: crypto.randomUUID(), role: 'user', content: 'concurrent' }),
    );
    const results = await Promise.all(writers);
    const successes = results.filter((row): row is MessageRow => row !== null);
    expect(successes).toHaveLength(8);
    const seqs = successes.map((row) => row.seq).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(seqs.length);
    for (let i = 1; i < seqs.length; i += 1) {
      const prev = seqs[i - 1] as number;
      expect(seqs[i]).toBe(prev + 1);
    }
  });
});

describe('Phase 5 message deletion', () => {
  it('deletes own message by UUID within own conversation', async () => {
    const owner = await seedUser(5001);
    const conversation = await seedConversation(owner);
    const message = await repo.appendMessage(owner, conversation.id, { id: crypto.randomUUID(), role: 'user', content: 'bye' });
    expect(message).not.toBeNull();
    const deleted = await service().deleteMessage(owner, conversation.id, message?.id);
    expect(deleted).toBe(true);
  });

  it('rejects non-UUID message ids and foreign targets', async () => {
    const owner = await seedUser(5002);
    const other = await seedUser(5003);
    const conversation = await seedConversation(owner);
    const message = await repo.appendMessage(owner, conversation.id, { id: crypto.randomUUID(), role: 'user', content: 'stay' });
    await expect(service().deleteMessage(owner, conversation.id, 'not-a-uuid')).rejects.toThrow(ConversationServiceError);
    const foreignConversation = await seedConversation(other);
    await expect(service().deleteMessage(owner, foreignConversation.id, message?.id)).resolves.toBe(false);
  });
});

describe('Phase 5 content faithfulness and no-log safety', () => {
  it('stores and returns arbitrary opaque text byte-for-byte, including secret-shaped markers', async () => {
    const owner = await seedUser(6001);
    const conversation = await seedConversation(owner);
    const secretShaped = 'line1\nsk-secret-abcdef1234567890\twith tab & <html> --; DROP TABLE users;--';
    const appended = await repo.appendMessage(owner, conversation.id, { id: crypto.randomUUID(), role: 'user', content: secretShaped });
    expect(appended?.content).toBe(secretShaped);
    const history = await repo.getConversationHistory(owner, conversation.id, 10);
    expect(history[0]?.content).toBe(secretShaped);
  });

  it('returns plain detached objects from service calls', async () => {
    const owner = await seedUser(6002);
    const conversation = await service().createConversation(owner, 'detach');
    const message = await service().appendMessage(owner, conversation.id, { role: 'user', content: 'plain' });
    expect(Object.getPrototypeOf(message)).toBe(Object.prototype);
    expect(Object.keys(message).sort()).toEqual(['content', 'conversation_id', 'created_at', 'id', 'role', 'seq', 'user_id']);
  });
});

describe('Phase 5 injected fake repository integration', () => {
  class FakeRepository implements ConversationRepository {
    readonly calls: string[] = [];
    private readonly conversations = new Map<string, ConversationRow>();
    private readonly messages: MessageRow[] = [];

    async createConversation(input: { userId: number; id: string; title: string; timestamp?: string }): Promise<ConversationRow | null> {
      this.calls.push('createConversation');
      const row: ConversationRow = { id: input.id, user_id: input.userId, title: input.title, status: 'active', created_at: input.timestamp ?? new Date().toISOString(), updated_at: input.timestamp ?? new Date().toISOString() };
      this.conversations.set(row.id, row);
      return row;
    }

    async getConversation(userId: number, conversationId: string): Promise<ConversationRow | null> {
      this.calls.push('getConversation');
      const row = this.conversations.get(conversationId);
      return row !== undefined && row.user_id === userId ? row : null;
    }

    async listConversations(userId: number, limit: number): Promise<ConversationRow[]> {
      this.calls.push('listConversations');
      return [...this.conversations.values()].filter((row) => row.user_id === userId).slice(0, limit);
    }

    async renameConversation(userId: number, conversationId: string, title: string, timestamp: string): Promise<ConversationRow | null> {
      this.calls.push('renameConversation');
      const row = await this.getConversation(userId, conversationId);
      if (row === null) return null;
      row.title = title;
      row.updated_at = row.updated_at > timestamp ? row.updated_at : timestamp;
      return row;
    }

    async archiveConversation(userId: number, conversationId: string, timestamp: string): Promise<ConversationRow | null> {
      this.calls.push('archiveConversation');
      const row = await this.getConversation(userId, conversationId);
      if (row === null) return null;
      row.status = 'archived';
      row.updated_at = row.updated_at > timestamp ? row.updated_at : timestamp;
      return row;
    }

    async deleteConversation(userId: number, conversationId: string): Promise<boolean> {
      this.calls.push('deleteConversation');
      const row = this.conversations.get(conversationId);
      if (row === undefined || row.user_id !== userId) return false;
      this.conversations.delete(conversationId);
      return true;
    }

    async getConversationHistory(userId: number, conversationId: string, limit: number): Promise<MessageRow[]> {
      this.calls.push('getConversationHistory');
      return this.messages.filter((message) => message.conversation_id === conversationId && message.user_id === userId).slice(-limit);
    }

    async appendMessage(userId: number, conversationId: string, input: { id: string; role: 'system' | 'user' | 'assistant'; content: string; timestamp?: string }): Promise<MessageRow | null> {
      this.calls.push('appendMessage');
      const conversation = this.conversations.get(conversationId);
      if (conversation === undefined || conversation.user_id !== userId) return null;
      const row: MessageRow = { id: input.id, conversation_id: conversationId, user_id: userId, seq: this.messages.length + 1, role: input.role, content: input.content, created_at: input.timestamp ?? new Date().toISOString() };
      this.messages.push(row);
      return row;
    }

    async deleteMessage(userId: number, conversationId: string, messageId: string): Promise<boolean> {
      this.calls.push('deleteMessage');
      const index = this.messages.findIndex((message) => message.id === messageId && message.conversation_id === conversationId && message.user_id === userId);
      if (index === -1) return false;
      this.messages.splice(index, 1);
      return true;
    }
  }

  it('runs the service fully offline against the injected port with no D1', async () => {
    const fake = new FakeRepository();
    const isolated = new ConversationService(fake);
    const created = await isolated.createConversation(7, 'fake');
    expect(fake.calls).toContain('createConversation');
    const message = await isolated.appendMessage(7, created.id, { role: 'user', content: 'opaque text' });
    expect(message?.seq).toBe(1);
    const history = await isolated.getHistory(7, created.id, 50);
    expect(history).toHaveLength(1);
    expect(history[0]?.content).toBe('opaque text');
    const archived = await isolated.archiveConversation(7, created.id);
    expect(archived.status).toBe('archived');
    expect(await isolated.deleteConversation(7, created.id)).toBe(true);
    expect(fake.calls).toContain('deleteConversation');
    expect(fake.calls).not.toContain('listConversations');
  });

  it('rejects the same invalid arguments against the fake as against D1', async () => {
    const isolated = new ConversationService(new FakeRepository());
    await expect(isolated.createConversation(0, 'x')).rejects.toThrow(ConversationServiceError);
    await expect(isolated.appendMessage(7, 'not-a-uuid', { role: 'user', content: 'x' })).rejects.toThrow(ConversationServiceError);
    await expect(isolated.appendMessage(7, crypto.randomUUID(), { role: 'tool', content: 'x' })).rejects.toThrow(ConversationServiceError);
    await expect(isolated.getHistory(7, crypto.randomUUID(), 0)).rejects.toThrow(ConversationServiceError);
  });
});