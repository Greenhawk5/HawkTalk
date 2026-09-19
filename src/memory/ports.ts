// Phase 10 semantic-memory ports.
// Provider-independent boundaries: the domain never imports Telegram, D1, or a
// Cloudflare binding directly. Adapters live in src/memory/embeddings.ts,
// src/memory/vectorize.ts, and src/db/memory.ts.

/** Bounds shared by every adapter and by the domain service. */
export const MEMORY_MAX_CONTENT_CHARS = 2000;
export const MEMORY_MIN_CONTENT_CHARS = 2;
export const MEMORY_MAX_QUERY_CHARS = 2000;
export const MEMORY_MAX_PER_USER = 200;
export const MEMORY_DEFAULT_TOP_K = 5;
export const MEMORY_MAX_TOP_K = 20;
/** Cosine similarity floor; hits below this are withheld from context. */
export const MEMORY_DEFAULT_MIN_SCORE = 0.35;
export const MEMORY_MAX_EMBED_INPUTS = 8;

export type MemoryStatus = 'pending' | 'active' | 'failed';
export type VectorState = 'pending' | 'synced' | 'failed';

export interface MemoryRecord {
  id: string;
  userId: number;
  content: string;
  status: MemoryStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryEmbeddingRecord {
  memoryId: string;
  vectorId: string;
  providerId: string;
  vendorModel: string;
  dimensions: number;
  vectorState: VectorState;
  createdAt: string;
  updatedAt: string;
}

/**
 * Embedding port. Implementations must return exactly `dimensions` floats per
 * input, must never expose credentials outward, and must fail with a generic
 * error (no key material, no upstream body text).
 */
export interface EmbeddingProvider {
  /** Stable provider identifier (e.g. 'cohere'); never a credential. */
  readonly id: string;
  /** Fixed output dimension. Must match the Vectorize index configuration. */
  readonly dimensions: number;
  /** Vendor model identifier sent to the embeddings endpoint. */
  readonly model: string;
  embed(inputs: readonly string[]): Promise<number[][]>;
}

export interface VectorMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown> | undefined;
}

export interface VectorQueryOptions {
  topK: number;
  /** Restricts matches to a single owner, when the index supports filtering. */
  filter?: Record<string, string> | undefined;
}

/**
 * Vector index port. `upsert` is idempotent by id (re-upserting replaces);
 * implementations must report failure by throwing, never by silence.
 */
export interface VectorIndex {
  upsert(vectors: ReadonlyArray<{ id: string; values: number[]; metadata: Record<string, string> }>): Promise<void>;
  query(values: number[], options: VectorQueryOptions): Promise<VectorMatch[]>;
  deleteByIds(ids: readonly string[]): Promise<void>;
}

/**
 * Owner-scoped persistence port. Every method takes `userId` and must scope
 * its statements to it: a row owned by another user must be indistinguishable
 * from a missing row.
 */
export interface MemoryRepository {
  insertMemory(input: { id: string; userId: number; content: string; createdAt: string }): Promise<boolean>;
  setMemoryStatus(userId: number, memoryId: string, status: MemoryStatus, updatedAt: string): Promise<boolean>;
  upsertMemoryEmbedding(input: {
    memoryId: string;
    vectorId: string;
    providerId: string;
    vendorModel: string;
    dimensions: number;
    vectorState: VectorState;
    timestamp: string;
  }): Promise<void>;
  /** Owner-scoped lookup of one memory plus its embedding reference. */
  findMemory(userId: number, memoryId: string): Promise<{ memory: MemoryRecord; embedding: MemoryEmbeddingRecord | null } | null>;
  /** Recall candidates limited to one owner and to synced+active rows. */
  findMemoriesByVectorIds(userId: number, vectorIds: readonly string[]): Promise<MemoryRecord[]>;
  listMemories(userId: number, limit: number): Promise<MemoryRecord[]>;
  deleteMemory(userId: number, memoryId: string): Promise<{ deleted: boolean; vectorId: string | null }>;
  countMemories(userId: number): Promise<number>;
  clearMemories(userId: number): Promise<string[]>;
}

export class MemoryError extends Error {
  readonly kind: 'invalid' | 'capacity' | 'unavailable' | 'not_found';

  constructor(kind: 'invalid' | 'capacity' | 'unavailable' | 'not_found') {
    super(`Memory error: ${kind}`);
    this.name = 'MemoryError';
    this.kind = kind;
  }
}

export function requireUserId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new MemoryError('invalid');
  return value;
}

export function requireContent(value: unknown, max = MEMORY_MAX_CONTENT_CHARS): string {
  if (typeof value !== 'string') throw new MemoryError('invalid');
  const trimmed = value.trim();
  if (trimmed.length < MEMORY_MIN_CONTENT_CHARS || trimmed.length > max) throw new MemoryError('invalid');
  return trimmed;
}

export function clampTopK(value: number): number {
  if (!Number.isInteger(value) || value < 1) return MEMORY_DEFAULT_TOP_K;
  return Math.min(value, MEMORY_MAX_TOP_K);
}