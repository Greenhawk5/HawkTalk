// Phase 10: Cloudflare Workers AI embedding provider implementing EmbeddingProvider.
// Uses the Ai binding to run @cf/baai/bge-m3 (1024-dim, multilingual/Persian-native).
// Fail-closed: throws MemoryError('unavailable') when the binding is absent or returns
// unexpected shapes. Never exposes credentials or upstream error bodies.

import { MEMORY_MAX_EMBED_INPUTS, MEMORY_MAX_QUERY_CHARS, MemoryError } from './ports';
import type { EmbeddingProvider } from './ports';

export const WORKERS_AI_EMBEDDING_MODEL = '@cf/baai/bge-m3';
export const WORKERS_AI_EMBEDDING_DIMENSIONS = 1024;
export const WORKERS_AI_EMBEDDING_PROVIDER_ID = 'workers-ai-bge-m3';

export interface WorkersAiEmbeddingProviderOptions {
  ai: Ai;
  model?: string;
}

function isAiBinding(value: unknown): value is Ai {
  return (
    typeof value === 'object' &&
    value !== null &&
    'run' in value &&
    typeof (value as Ai).run === 'function'
  );
}

export class WorkersAiEmbeddingProvider implements EmbeddingProvider {
  readonly id = WORKERS_AI_EMBEDDING_PROVIDER_ID;
  readonly model: string;
  readonly dimensions = WORKERS_AI_EMBEDDING_DIMENSIONS;
  private readonly ai: Ai;

  constructor(options: WorkersAiEmbeddingProviderOptions) {
    if (!isAiBinding(options.ai)) throw new MemoryError('unavailable');
    this.ai = options.ai;
    this.model = options.model ?? WORKERS_AI_EMBEDDING_MODEL;
  }

  async embed(inputs: readonly string[]): Promise<number[][]> {
    if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > MEMORY_MAX_EMBED_INPUTS) {
      throw new MemoryError('invalid');
    }
    for (const input of inputs) {
      if (typeof input !== 'string' || input.length === 0 || input.length > MEMORY_MAX_QUERY_CHARS) {
        throw new MemoryError('invalid');
      }
    }

    let result: unknown;
    try {
      result = await this.ai.run(this.model as never, { text: [...inputs] } as never);
    } catch {
      throw new MemoryError('unavailable');
    }

    if (typeof result !== 'object' || result === null) throw new MemoryError('unavailable');
    const record = result as Record<string, unknown>;
    const data = record['data'];
    if (!Array.isArray(data) || data.length !== inputs.length) throw new MemoryError('unavailable');

    const vectors: number[][] = [];
    for (const entry of data) {
      if (!Array.isArray(entry) || entry.length !== this.dimensions) throw new MemoryError('unavailable');
      const values: number[] = [];
      for (const value of entry) {
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new MemoryError('unavailable');
        values.push(value);
      }
      vectors.push(values);
    }
    return vectors;
  }
}
