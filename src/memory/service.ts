// Phase 10: local, dependency-free semantic memory.
// A deterministic character-n-gram hash embedder (pure, no network, no API
// key) so recall works fully offline and is exactly testable. Quality is
// intentionally modest: this is a durable, privacy-preserving memory
// foundation, not a cloud-embedding integration.

export const MEMORY_EMBEDDING_DIMENSIONS = 64;
export const MEMORY_MIN_QUERY_CHARS = 2;
export const MEMORY_MAX_TEXT_CHARS = 2000;

export interface StoredMemory {
  userId: number;
  fact: string;
  embedding: number[];
  createdAt: string;
}

function isStoredMemory(value: unknown): value is StoredMemory {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row['userId'] === 'number' &&
    typeof row['fact'] === 'string' &&
    Array.isArray(row['embedding']) &&
    row['embedding'].every((entry) => typeof entry === 'number') &&
    typeof row['createdAt'] === 'string'
  );
}

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic unit-length embedding from lowercased alphanumeric 3-grams
 * plus whole-word tokens. Identical text always yields identical vectors;
 * unrelated text scores near zero. Output is L2-normalized (or all zeros
 * when no features exist, e.g. empty input).
 */
export function embedTextLocal(text: string): number[] {
  const vector = new Array<number>(MEMORY_EMBEDDING_DIMENSIONS).fill(0);
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const compact = normalized.replace(/\s+/g, ' ').trim();
  if (compact.length === 0) return vector;
  const features: string[] = [];
  for (let i = 0; i + 3 <= compact.length; i += 1) features.push(compact.slice(i, i + 3));
  for (const word of compact.split(' ')) if (word.length >= 2) features.push(`w:${word}`);
  for (const feature of features) {
    const slot = fnv1a32(feature) % MEMORY_EMBEDDING_DIMENSIONS;
    vector[slot] = (vector[slot] as number) + 1;
  }
  let norm = 0;
  for (const entry of vector) norm += entry * entry;
  norm = Math.sqrt(norm);
  if (norm === 0) return vector;
  return vector.map((entry) => entry / norm);
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < length; i += 1) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

export function validateMemoryFact(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < MEMORY_MIN_QUERY_CHARS || value.length > MEMORY_MAX_TEXT_CHARS) {
    throw new Error('Invalid memory fact');
  }
  return value.trim();
}

export interface MemoryStore {
  saveMemory(memory: StoredMemory): Promise<void>;
  listMemories(userId: number): Promise<StoredMemory[]>;
  clearMemories(userId: number): Promise<void>;
}

/** In-memory store for tests and ephemeral deployments. */
export class InMemoryMemoryStore implements MemoryStore {
  private readonly rows = new Map<number, StoredMemory[]>();

  async saveMemory(memory: StoredMemory): Promise<void> {
    if (!isStoredMemory(memory)) throw new Error('Invalid memory');
    const list = this.rows.get(memory.userId) ?? [];
    list.push({ ...memory, embedding: [...memory.embedding] });
    this.rows.set(memory.userId, list);
  }

  async listMemories(userId: number): Promise<StoredMemory[]> {
    return (this.rows.get(userId) ?? []).map((row) => ({ ...row, embedding: [...row.embedding] }));
  }

  async clearMemories(userId: number): Promise<void> {
    this.rows.delete(userId);
  }
}

export interface RememberResult {
  fact: string;
  dimensions: number;
}

export interface RecallHit {
  fact: string;
  score: number;
}

export class MemoryService {
  private readonly store: MemoryStore;
  private readonly clock: () => string;
  readonly maxMemoriesPerUser: number;

  constructor(store: MemoryStore, options?: { clock?: (() => string) | undefined; maxMemoriesPerUser?: number | undefined }) {
    this.store = store;
    this.clock = options?.clock ?? (() => new Date().toISOString());
    this.maxMemoriesPerUser = options?.maxMemoriesPerUser ?? 50;
  }

  /** Stores one bounded fact for the caller's own user id. */
  async remember(userId: number, fact: unknown): Promise<RememberResult> {
    if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0) throw new Error('Invalid user id');
    const clean = validateMemoryFact(fact);
    const existing = await this.store.listMemories(userId);
    if (existing.length >= this.maxMemoriesPerUser) throw new Error('Memory limit reached');
    await this.store.saveMemory({ userId, fact: clean, embedding: embedTextLocal(clean), createdAt: this.clock() });
    return { fact: clean, dimensions: MEMORY_EMBEDDING_DIMENSIONS };
  }

  /**
   * Owner-scoped recall: ranks only the caller's own facts by cosine
   * similarity. Facts below `minScore` are withheld (default 0.2).
   */
  async recall(userId: number, query: unknown, limit = 3, minScore = 0.2): Promise<RecallHit[]> {
    if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0) throw new Error('Invalid user id');
    if (typeof query !== 'string' || query.trim().length < MEMORY_MIN_QUERY_CHARS || query.length > MEMORY_MAX_TEXT_CHARS) {
      return [];
    }
    const pageSize = Math.min(Math.max(1, Math.floor(limit)), 10);
    const embedding = embedTextLocal(query);
    const scored = (await this.store.listMemories(userId))
      .map((row) => ({ fact: row.fact, score: cosineSimilarity(embedding, row.embedding) }))
      .filter((hit) => hit.score >= minScore)
      .sort((a, b) => b.score - a.score || (a.fact < b.fact ? -1 : a.fact > b.fact ? 1 : 0));
    return scored.slice(0, pageSize);
  }

  async forgetAll(userId: number): Promise<void> {
    if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0) throw new Error('Invalid user id');
    await this.store.clearMemories(userId);
  }
}

/**
 * Renders recalled facts as one bounded context block. Facts are wrapped in
 * explicit untrusted delimiters: recalled content is data for the model,
 * never instructions.
 */
export function renderMemoryContext(hits: readonly RecallHit[], maxChars = 2000): string {
  if (hits.length === 0) return '';
  const lines = hits.map((hit) => `- ${hit.fact}`).join('\n').slice(0, maxChars);
  return `<untrusted_memory>\n${lines}\n</untrusted_memory>`;
}

