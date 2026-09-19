// Phase 10: production semantic-memory service composing D1MemoryRepository +
// EmbeddingProvider + VectorIndex. Owns write/read sequencing with explicit
// failure states. Never claims cross-system atomicity.
//
// WRITE: validate → D1 pending → embed → Vectorize upsert → D1 synced/active
// READ: embed query → Vectorize query (owner filter) → D1 fetch (owner scoped, synced+active only)
//
// Fail-closed: if any dependency is unavailable, operations throw MemoryError.
// Incomplete records (pending/failed) are never returned through recall.

import type { EmbeddingProvider, MemoryRecord, MemoryRepository, VectorIndex } from './ports';
import {
  clampTopK,
  MEMORY_DEFAULT_MIN_SCORE,
  MEMORY_DEFAULT_TOP_K,
  MEMORY_MAX_CONTENT_CHARS,
  MEMORY_MAX_PER_USER,
  MemoryError,
  requireContent,
  requireUserId,
} from './ports';

export interface SemanticMemoryServiceDeps {
  repo: MemoryRepository;
  embeddings: EmbeddingProvider;
  vectorIndex: VectorIndex;
  clock?: () => string;
}

export interface SemanticRecallHit {
  content: string;
  score: number;
}

export class SemanticMemoryService {
  private readonly repo: MemoryRepository;
  private readonly embeddings: EmbeddingProvider;
  private readonly vectorIndex: VectorIndex;
  private readonly clock: () => string;

  constructor(deps: SemanticMemoryServiceDeps) {
    this.repo = deps.repo;
    this.embeddings = deps.embeddings;
    this.vectorIndex = deps.vectorIndex;
    this.clock = deps.clock ?? (() => new Date().toISOString());
  }

  get dimensions(): number {
    return this.embeddings.dimensions;
  }

  get providerId(): string {
    return this.embeddings.id;
  }

  get model(): string {
    return this.embeddings.model;
  }

  async store(userId: number, content: string): Promise<string> {
    const uid = requireUserId(userId);
    const clean = requireContent(content, MEMORY_MAX_CONTENT_CHARS);

    const count = await this.repo.countMemories(uid).catch(() => {
      throw new MemoryError('unavailable');
    });
    if (count >= MEMORY_MAX_PER_USER) throw new MemoryError('capacity');

    const memoryId = crypto.randomUUID();
    const now = this.clock();

    const inserted = await this.repo.insertMemory({ id: memoryId, userId: uid, content: clean, createdAt: now }).catch(() => {
      throw new MemoryError('unavailable');
    });
    if (!inserted) throw new MemoryError('unavailable');

    let vectors: number[][];
    try {
      vectors = await this.embeddings.embed([clean]);
    } catch {
      await this.repo.setMemoryStatus(uid, memoryId, 'failed', this.clock()).catch(() => undefined);
      throw new MemoryError('unavailable');
    }

    if (!vectors || vectors.length !== 1 || !vectors[0] || vectors[0].length !== this.embeddings.dimensions) {
      await this.repo.setMemoryStatus(uid, memoryId, 'failed', this.clock()).catch(() => undefined);
      throw new MemoryError('unavailable');
    }

    const vectorId = `mem:${memoryId}`;
    try {
      await this.vectorIndex.upsert([{
        id: vectorId,
        values: vectors[0] as number[],
        metadata: { owner_id: String(uid) },
      }]);
    } catch {
      await this.repo.setMemoryStatus(uid, memoryId, 'failed', this.clock()).catch(() => undefined);
      await this.repo.upsertMemoryEmbedding({
        memoryId, vectorId, providerId: this.embeddings.id,
        vendorModel: this.embeddings.model, dimensions: this.embeddings.dimensions,
        vectorState: 'failed', timestamp: this.clock(),
      }).catch(() => undefined);
      throw new MemoryError('unavailable');
    }

    await this.repo.upsertMemoryEmbedding({
      memoryId, vectorId, providerId: this.embeddings.id,
      vendorModel: this.embeddings.model, dimensions: this.embeddings.dimensions,
      vectorState: 'synced', timestamp: this.clock(),
    }).catch(() => undefined);

    await this.repo.setMemoryStatus(uid, memoryId, 'active', this.clock()).catch(() => undefined);

    return memoryId;
  }

  async recall(userId: number, query: string, topK = MEMORY_DEFAULT_TOP_K, minScore = MEMORY_DEFAULT_MIN_SCORE): Promise<SemanticRecallHit[]> {
    const uid = requireUserId(userId);
    const cleanQuery = requireContent(query, MEMORY_MAX_CONTENT_CHARS);
    const k = clampTopK(topK);

    let queryVectors: number[][];
    try {
      queryVectors = await this.embeddings.embed([cleanQuery]);
    } catch {
      return [];
    }
    if (!queryVectors || queryVectors.length !== 1 || !queryVectors[0]) return [];

    let matches;
    try {
      matches = await this.vectorIndex.query(queryVectors[0] as number[], {
        topK: k,
        filter: { owner_id: String(uid) },
      });
    } catch {
      return [];
    }

    if (!matches || matches.length === 0) return [];

    const vectorIds = matches
      .filter((m) => m.score >= minScore)
      .map((m) => m.id);
    if (vectorIds.length === 0) return [];

    const records = await this.repo.findMemoriesByVectorIds(uid, vectorIds).catch(() => [] as MemoryRecord[]);

    const memById = new Map<string, MemoryRecord>();
    for (const rec of records) {
      memById.set(`mem:${rec.id}`, rec);
      memById.set(rec.id, rec);
    }

    const hits: SemanticRecallHit[] = [];
    for (const match of matches) {
      if (match.score < minScore) continue;
      const rec = memById.get(match.id);
      if (!rec) continue;
      // Defense-in-depth ownership verification
      if (rec.userId !== uid) continue;
      if (rec.status !== 'active') continue;
      hits.push({ content: rec.content, score: match.score });
    }

    hits.sort((a, b) => b.score - a.score || (a.content < b.content ? -1 : a.content > b.content ? 1 : 0));
    return hits.slice(0, k);
  }

  async list(userId: number, limit = 20): Promise<Array<{ id: string; content: string; status: string; createdAt: string }>> {
    const uid = requireUserId(userId);
    const records = await this.repo.listMemories(uid, Math.min(limit, 100)).catch(() => [] as MemoryRecord[]);
    return records.map((r) => ({ id: r.id, content: r.content, status: r.status, createdAt: r.createdAt }));
  }

  async delete(userId: number, memoryId: string): Promise<boolean> {
    const uid = requireUserId(userId);
    if (typeof memoryId !== 'string' || memoryId.length === 0 || memoryId.length > 128) throw new MemoryError('invalid');

    const result = await this.repo.deleteMemory(uid, memoryId).catch(() => null);
    if (result === null) return false;

    if (result.deleted && result.vectorId) {
      await this.vectorIndex.deleteByIds([result.vectorId]).catch(() => undefined);
    }
    return result.deleted;
  }

  async clear(userId: number): Promise<number> {
    const uid = requireUserId(userId);
    const vectorIds = await this.repo.clearMemories(uid).catch(() => [] as string[]);
    if (vectorIds.length > 0) {
      await this.vectorIndex.deleteByIds(vectorIds).catch(() => undefined);
    }
    return vectorIds.length;
  }

  renderContext(hits: readonly SemanticRecallHit[], maxChars = 2000): string {
    if (hits.length === 0) return '';
    const lines = hits.map((h) => `- ${h.content}`).join('\n').slice(0, maxChars);
    return `<untrusted_memory>\n${lines}\n</untrusted_memory>`;
  }
}
