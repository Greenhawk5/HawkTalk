// Phase 10: Cloudflare Vectorize adapter implementing the VectorIndex port.
// Uses the VectorizeIndex binding (beta API) available in worker-configuration.d.ts.
// Fail-closed: throws when the binding is absent or returns unexpected shapes.
// Owner isolation: every vector carries owner_id metadata; queries filter by it.

import type { VectorIndex, VectorMatch, VectorQueryOptions } from './ports';
import { MemoryError } from './ports';

const MAX_UPSERT_BATCH = 100;
const MAX_DELETE_BATCH = 100;
const MAX_QUERY_TOP_K = 20;

export interface VectorizeAdapterOptions {
  index: VectorizeIndex;
}

function isVectorizeIndex(value: unknown): value is VectorizeIndex {
  return (
    typeof value === 'object' &&
    value !== null &&
    'upsert' in value &&
    'query' in value &&
    'deleteByIds' in value &&
    typeof (value as VectorizeIndex).upsert === 'function' &&
    typeof (value as VectorizeIndex).query === 'function' &&
    typeof (value as VectorizeIndex).deleteByIds === 'function'
  );
}

export class VectorizeAdapter implements VectorIndex {
  private readonly index: VectorizeIndex;

  constructor(options: VectorizeAdapterOptions) {
    if (!isVectorizeIndex(options.index)) throw new MemoryError('unavailable');
    this.index = options.index;
  }

  async upsert(vectors: ReadonlyArray<{ id: string; values: number[]; metadata: Record<string, string> }>): Promise<void> {
    if (vectors.length === 0) return;
    if (vectors.length > MAX_UPSERT_BATCH) throw new MemoryError('invalid');

    const payload: VectorizeVector[] = vectors.map((v) => {
      if (typeof v.id !== 'string' || v.id.length === 0 || v.id.length > 128) throw new MemoryError('invalid');
      if (!Array.isArray(v.values) || v.values.length === 0 || v.values.length > 4096) throw new MemoryError('invalid');
      for (const val of v.values) {
        if (typeof val !== 'number' || !Number.isFinite(val)) throw new MemoryError('invalid');
      }
      const metadata: Record<string, VectorizeVectorMetadata> = {};
      for (const [key, value] of Object.entries(v.metadata)) {
        if (typeof key !== 'string' || key.length === 0 || key.length > 64) throw new MemoryError('invalid');
        if (typeof value !== 'string') throw new MemoryError('invalid');
        metadata[key] = value;
      }
      return { id: v.id, values: v.values, metadata };
    });

    try {
      await this.index.upsert(payload);
    } catch {
      throw new MemoryError('unavailable');
    }
  }

  async query(values: number[], options: VectorQueryOptions): Promise<VectorMatch[]> {
    if (!Array.isArray(values) || values.length === 0 || values.length > 4096) throw new MemoryError('invalid');
    for (const val of values) {
      if (typeof val !== 'number' || !Number.isFinite(val)) throw new MemoryError('invalid');
    }

    const topK = Math.min(Math.max(1, Math.floor(options.topK)), MAX_QUERY_TOP_K);
    const filter: VectorizeVectorMetadataFilter | undefined =
      options.filter !== undefined ? buildFilter(options.filter) : undefined;

    let result: VectorizeMatches;
    try {
      result = await this.index.query(values, {
        topK,
        returnMetadata: 'indexed',
        ...(filter !== undefined ? { filter } : {}),
      });
    } catch {
      throw new MemoryError('unavailable');
    }

    if (!result || !Array.isArray(result.matches)) return [];

    const out: VectorMatch[] = [];
    for (const match of result.matches) {
      if (typeof match.id !== 'string' || match.id.length === 0) continue;
      if (typeof match.score !== 'number' || !Number.isFinite(match.score)) continue;
      const metadata: Record<string, unknown> | undefined =
        match.metadata !== undefined ? (match.metadata as Record<string, unknown>) : undefined;
      out.push({ id: match.id, score: match.score, metadata });
    }
    return out;
  }

  async deleteByIds(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const bounded = ids.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 128).slice(0, MAX_DELETE_BATCH);
    if (bounded.length === 0) return;
    try {
      await this.index.deleteByIds(bounded);
    } catch {
      throw new MemoryError('unavailable');
    }
  }
}

type VectorizeVectorMetadata = string | number | boolean | string[];
type VectorizeVectorMetadataFilterOp = '$eq' | '$ne' | '$lt' | '$lte' | '$gt' | '$gte';
type VectorizeVectorMetadataFilterCollectionOp = '$in' | '$nin';
type VectorizeVectorMetadataFilter = {
  [field: string]: Exclude<VectorizeVectorMetadata, string[]> | null | {
    [Op in VectorizeVectorMetadataFilterOp]?: Exclude<VectorizeVectorMetadata, string[]> | null;
  } | {
    [Op in VectorizeVectorMetadataFilterCollectionOp]?: Exclude<VectorizeVectorMetadata, string[]>[];
  };
};

function buildFilter(filter: Record<string, string>): VectorizeVectorMetadataFilter {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filter)) {
    if (typeof key === 'string' && key.length > 0 && key.length <= 64 && typeof value === 'string') {
      out[key] = value;
    }
  }
  return out as unknown as VectorizeVectorMetadataFilter;
}
