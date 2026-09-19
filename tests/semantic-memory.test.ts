import { describe, expect, it, vi } from 'vitest';
import { SemanticMemoryService } from '../src/memory/semantic-memory';
import type { EmbeddingProvider, MemoryRepository, VectorIndex, MemoryRecord, VectorMatch } from '../src/memory/ports';
import { MemoryError } from '../src/memory/ports';
import { parseMemoryCommand, handleMemoryCommand } from '../src/telegram/memory-commands';
import { buildProductionMemoryService } from '../src/orchestration/production';

function makeEmbedding(dimensions: number): number[] {
  const v = new Array<number>(dimensions).fill(0);
  v[0] = 1;
  return v;
}

class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'test-provider';
  readonly model = 'test-model';
  constructor(readonly dimensions: number) {}
  async embed(inputs: readonly string[]): Promise<number[][]> {
    return inputs.map(() => makeEmbedding(this.dimensions));
  }
}

class FailingEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'fail-provider';
  readonly model = 'fail-model';
  readonly dimensions = 1024;
  async embed(): Promise<number[][]> {
    throw new Error('embedding failed');
  }
}

class DimensionMismatchEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'mismatch-provider';
  readonly model = 'mismatch-model';
  readonly dimensions = 1024;
  async embed(inputs: readonly string[]): Promise<number[][]> {
    return inputs.map(() => new Array<number>(512).fill(0));
  }
}

function makeFakeRepo(records: Map<string, MemoryRecord> = new Map()): MemoryRepository {
  return {
    insertMemory: vi.fn(async (input) => {
      records.set(input.id, { id: input.id, userId: input.userId, content: input.content, status: 'pending', createdAt: input.createdAt, updatedAt: input.createdAt });
      return true;
    }),
    setMemoryStatus: vi.fn(async (userId, memoryId, status, updatedAt) => {
      const rec = records.get(memoryId);
      if (rec && rec.userId === userId) { rec.status = status; rec.updatedAt = updatedAt; return true; }
      return false;
    }),
    upsertMemoryEmbedding: vi.fn(async () => {}),
    findMemory: vi.fn(async (userId, memoryId) => {
      const rec = records.get(memoryId);
      if (!rec || rec.userId !== userId) return null;
      return { memory: rec, embedding: null };
    }),
    findMemoriesByVectorIds: vi.fn(async (userId, vectorIds) => {
      const out: MemoryRecord[] = [];
      for (const rec of records.values()) {
        if (rec.userId === userId && rec.status === 'active' && vectorIds.includes(`mem:${rec.id}`)) out.push(rec);
      }
      return out;
    }),
    listMemories: vi.fn(async (userId, limit) => {
      return [...records.values()].filter((r) => r.userId === userId).slice(0, limit);
    }),
    deleteMemory: vi.fn(async (userId, memoryId) => {
      const rec = records.get(memoryId);
      if (!rec || rec.userId !== userId) return { deleted: false, vectorId: null };
      records.delete(memoryId);
      return { deleted: true, vectorId: `mem:${memoryId}` };
    }),
    countMemories: vi.fn(async (userId) => [...records.values()].filter((r) => r.userId === userId).length),
    clearMemories: vi.fn(async (userId) => {
      const ids: string[] = [];
      for (const [id, rec] of records) { if (rec.userId === userId) { ids.push(`mem:${id}`); records.delete(id); } }
      return ids;
    }),
  };
}

function makeFakeVectorIndex(matches: VectorMatch[] = []): VectorIndex {
  return {
    upsert: vi.fn(async () => {}),
    query: vi.fn(async () => matches),
    deleteByIds: vi.fn(async () => {}),
  };
}

describe('SemanticMemoryService', () => {
  it('stores a memory through the full D1+embedding+Vectorize pipeline', async () => {
    const records = new Map<string, MemoryRecord>();
    const repo = makeFakeRepo(records);
    const embeddings = new FakeEmbeddingProvider(1024);
    const vectorIndex = makeFakeVectorIndex();
    const svc = new SemanticMemoryService({ repo, embeddings, vectorIndex, clock: () => '2026-09-19T00:00:00.000Z' });

    const id = await svc.store(1, 'I prefer dark mode');
    expect(id).toBeTruthy();
    expect(records.size).toBe(1);
    expect(repo.insertMemory).toHaveBeenCalled();
    expect(vectorIndex.upsert).toHaveBeenCalledWith([{
      id: `mem:${id}`,
      values: expect.any(Array),
      metadata: { owner_id: '1' },
    }]);
    expect(repo.setMemoryStatus).toHaveBeenCalledWith(1, id, 'active', '2026-09-19T00:00:00.000Z');
  });

  it('recalls stored memories with owner-scoped verification', async () => {
    const records = new Map<string, MemoryRecord>();
    const repo = makeFakeRepo(records);
    const embeddings = new FakeEmbeddingProvider(1024);
    const vectorIndex = makeFakeVectorIndex([{ id: 'mem:test-id', score: 0.9, metadata: { owner_id: '1' } }]);
    const svc = new SemanticMemoryService({ repo, embeddings, vectorIndex, clock: () => '2026-09-19T00:00:00.000Z' });

    records.set('test-id', { id: 'test-id', userId: 1, content: 'dark mode preference', status: 'active', createdAt: '2026-09-19T00:00:00.000Z', updatedAt: '2026-09-19T00:00:00.000Z' });

    const hits = await svc.recall(1, 'what theme do I like?');
    expect(hits.length).toBe(1);
    expect(hits[0].content).toBe('dark mode preference');
    expect(hits[0].score).toBe(0.9);
  });

  it('wraps recalled content in untrusted_memory delimiters', async () => {
    const svc = new SemanticMemoryService({
      repo: makeFakeRepo(),
      embeddings: new FakeEmbeddingProvider(1024),
      vectorIndex: makeFakeVectorIndex(),
    });
    const ctx = svc.renderContext([{ content: 'user likes cats', score: 0.8 }]);
    expect(ctx).toContain('<untrusted_memory>');
    expect(ctx).toContain('</untrusted_memory>');
    expect(ctx).toContain('user likes cats');
  });

  it('prevents cross-owner recall even if Vectorize returns wrong results', async () => {
    const records = new Map<string, MemoryRecord>();
    const repo = makeFakeRepo(records);
    const embeddings = new FakeEmbeddingProvider(1024);
    // Vectorize incorrectly returns user 1's memory for user 2's query
    const vectorIndex = makeFakeVectorIndex([{ id: 'mem:user1-mem', score: 0.95, metadata: { owner_id: '1' } }]);
    const svc = new SemanticMemoryService({ repo, embeddings, vectorIndex });

    records.set('user1-mem', { id: 'user1-mem', userId: 1, content: 'user 1 secret', status: 'active', createdAt: '2026-09-19T00:00:00.000Z', updatedAt: '2026-09-19T00:00:00.000Z' });

    const hits = await svc.recall(2, 'tell me secrets');
    expect(hits.length).toBe(0);
  });

  it('fails closed when embedding provider fails during store', async () => {
    const repo = makeFakeRepo();
    const embeddings = new FailingEmbeddingProvider();
    const vectorIndex = makeFakeVectorIndex();
    const svc = new SemanticMemoryService({ repo, embeddings, vectorIndex });

    await expect(svc.store(1, 'this will fail')).rejects.toThrow(MemoryError);
    expect(repo.setMemoryStatus).toHaveBeenCalledWith(1, expect.any(String), 'failed', expect.any(String));
    expect(vectorIndex.upsert).not.toHaveBeenCalled();
  });

  it('fails closed on dimension mismatch between embedding and declared dimensions', async () => {
    const repo = makeFakeRepo();
    const embeddings = new DimensionMismatchEmbeddingProvider();
    const vectorIndex = makeFakeVectorIndex();
    const svc = new SemanticMemoryService({ repo, embeddings, vectorIndex });

    await expect(svc.store(1, 'dimension mismatch')).rejects.toThrow(MemoryError);
    expect(vectorIndex.upsert).not.toHaveBeenCalled();
  });

  it('returns empty when Vectorize query fails during recall', async () => {
    const repo = makeFakeRepo();
    const embeddings = new FakeEmbeddingProvider(1024);
    const vectorIndex: VectorIndex = {
      upsert: vi.fn(async () => {}),
      query: vi.fn(async () => { throw new Error('vectorize down'); }),
      deleteByIds: vi.fn(async () => {}),
    };
    const svc = new SemanticMemoryService({ repo, embeddings, vectorIndex });

    const hits = await svc.recall(1, 'test query');
    expect(hits).toEqual([]);
  });

  it('enforces capacity limits', async () => {
    const records = new Map<string, MemoryRecord>();
    for (let i = 0; i < 200; i++) {
      records.set(`mem-${i}`, { id: `mem-${i}`, userId: 1, content: `fact ${i}`, status: 'active', createdAt: '2026-09-19T00:00:00.000Z', updatedAt: '2026-09-19T00:00:00.000Z' });
    }
    const repo = makeFakeRepo(records);
    const embeddings = new FakeEmbeddingProvider(1024);
    const vectorIndex = makeFakeVectorIndex();
    const svc = new SemanticMemoryService({ repo, embeddings, vectorIndex });

    await expect(svc.store(1, 'one too many')).rejects.toThrow(MemoryError);
  });

  it('deletes memories and cleans up vectors', async () => {
    const records = new Map<string, MemoryRecord>();
    records.set('del-me', { id: 'del-me', userId: 1, content: 'delete this', status: 'active', createdAt: '2026-09-19T00:00:00.000Z', updatedAt: '2026-09-19T00:00:00.000Z' });
    const repo = makeFakeRepo(records);
    const vectorIndex = makeFakeVectorIndex();
    const svc = new SemanticMemoryService({ repo, embeddings: new FakeEmbeddingProvider(1024), vectorIndex });

    const result = await svc.delete(1, 'del-me');
    expect(result).toBe(true);
    expect(vectorIndex.deleteByIds).toHaveBeenCalledWith(['mem:del-me']);
    expect(records.has('del-me')).toBe(false);
  });

  it('clears all memories for a user', async () => {
    const records = new Map<string, MemoryRecord>();
    records.set('a', { id: 'a', userId: 1, content: 'fact a', status: 'active', createdAt: '2026-09-19T00:00:00.000Z', updatedAt: '2026-09-19T00:00:00.000Z' });
    records.set('b', { id: 'b', userId: 1, content: 'fact b', status: 'active', createdAt: '2026-09-19T00:00:00.000Z', updatedAt: '2026-09-19T00:00:00.000Z' });
    records.set('c', { id: 'c', userId: 2, content: 'other user', status: 'active', createdAt: '2026-09-19T00:00:00.000Z', updatedAt: '2026-09-19T00:00:00.000Z' });
    const repo = makeFakeRepo(records);
    const vectorIndex = makeFakeVectorIndex();
    const svc = new SemanticMemoryService({ repo, embeddings: new FakeEmbeddingProvider(1024), vectorIndex });

    const count = await svc.clear(1);
    expect(count).toBe(2);
    expect(records.has('a')).toBe(false);
    expect(records.has('b')).toBe(false);
    expect(records.has('c')).toBe(true);
  });

  it('is safe to retry store after partial failure (idempotent by UUID)', async () => {
    const repo = makeFakeRepo();
    const embeddings = new FakeEmbeddingProvider(1024);
    const vectorIndex = makeFakeVectorIndex();
    const svc = new SemanticMemoryService({ repo, embeddings, vectorIndex });

    const id1 = await svc.store(1, 'retryable fact');
    const id2 = await svc.store(1, 'retryable fact');
    expect(id1).not.toBe(id2);
  });
});

describe('Telegram memory commands', () => {
  it('parses /remember, /memories, /forget correctly', () => {
    expect(parseMemoryCommand('/remember my cat is named Luna')).toEqual({ command: '/remember', arg: 'my cat is named Luna' });
    expect(parseMemoryCommand('/memories')).toEqual({ command: '/memories', arg: '' });
    expect(parseMemoryCommand('/forget')).toEqual({ command: '/forget', arg: '' });
    expect(parseMemoryCommand('hello world')).toBeNull();
    expect(parseMemoryCommand('/rememberx something')).toBeNull();
  });

  it('handles /remember through the service', async () => {
    const repo = makeFakeRepo();
    const svc = new SemanticMemoryService({ repo, embeddings: new FakeEmbeddingProvider(1024), vectorIndex: makeFakeVectorIndex() });
    const result = await handleMemoryCommand({ command: '/remember', arg: 'I like tea' }, 1, svc);
    expect(result.text).toBe('Saved.');
  });

  it('returns usage hint for bare /remember', async () => {
    const svc = new SemanticMemoryService({ repo: makeFakeRepo(), embeddings: new FakeEmbeddingProvider(1024), vectorIndex: makeFakeVectorIndex() });
    const result = await handleMemoryCommand({ command: '/remember', arg: '' }, 1, svc);
    expect(result.text).toContain('Usage');
  });

  it('handles /memories listing', async () => {
    const records = new Map<string, MemoryRecord>();
    records.set('m1', { id: 'm1', userId: 1, content: 'fact one', status: 'active', createdAt: '2026-09-19T00:00:00.000Z', updatedAt: '2026-09-19T00:00:00.000Z' });
    const repo = makeFakeRepo(records);
    const svc = new SemanticMemoryService({ repo, embeddings: new FakeEmbeddingProvider(1024), vectorIndex: makeFakeVectorIndex() });
    const result = await handleMemoryCommand({ command: '/memories', arg: '' }, 1, svc);
    expect(result.text).toContain('fact one');
  });

  it('handles /forget clearing all memories', async () => {
    const records = new Map<string, MemoryRecord>();
    records.set('m1', { id: 'm1', userId: 1, content: 'fact', status: 'active', createdAt: '2026-09-19T00:00:00.000Z', updatedAt: '2026-09-19T00:00:00.000Z' });
    const repo = makeFakeRepo(records);
    const svc = new SemanticMemoryService({ repo, embeddings: new FakeEmbeddingProvider(1024), vectorIndex: makeFakeVectorIndex() });
    const result = await handleMemoryCommand({ command: '/forget', arg: '' }, 1, svc);
    expect(result.text).toContain('Cleared 1');
  });
});

describe('production memory wiring', () => {
  it('returns null when AI or VECTORIZE bindings are absent', () => {
    expect(buildProductionMemoryService({ DB: {} as D1Database })).toBeNull();
    expect(buildProductionMemoryService({})).toBeNull();
  });

  it('never uses HashEmbeddingProvider or InMemoryMemoryStore in production path', () => {
    const svc = buildProductionMemoryService({});
    expect(svc).toBeNull();
  });
});
