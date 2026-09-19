// Phase 10 embedding providers.
//
// PRODUCTION: OpenAICompatibleEmbeddingProvider posts to `{baseUrl}/embeddings`
// with `Authorization: Bearer <key>`, exactly as the chat adapter posts to
// `{baseUrl}/chat/completions`. It reuses the EXISTING sealed-credential
// architecture: the key arrives already decrypted by the caller
// (resolveCredentialPlaintext + CREDENTIAL_MASTER_SECRET), is used for one
// request, and is never logged, cached, returned, or embedded in errors.
//
// TESTING/DEV ONLY: HashEmbeddingProvider is the deterministic local embedder.
// It is explicitly NOT the production semantic-memory embedding system and
// must never be wired as the production provider.

import { MEMORY_MAX_EMBED_INPUTS, MEMORY_MAX_QUERY_CHARS } from './ports';
import type { EmbeddingProvider } from './ports';
import { embedTextLocal, MEMORY_EMBEDDING_DIMENSIONS } from './service';

export const EMBEDDINGS_PATH = '/embeddings';
export const DEFAULT_EMBEDDING_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_INPUT_CHARS = MEMORY_MAX_QUERY_CHARS;

export class EmbeddingError extends Error {
  constructor() {
    // Generic by construction: never carries provider text or key material.
    super('Embedding request failed');
    this.name = 'EmbeddingError';
  }
}

export interface OpenAICompatibleEmbeddingProviderOptions {
  id: string;
  baseUrl: string;
  model: string;
  dimensions: number;
  /** Decrypted for this provider only; never persisted by this module. */
  apiKey: string;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * OpenAI-compatible embeddings client (`POST {baseUrl}/embeddings`).
 * Validates the fixed dimension on every response, so a model/config mismatch
 * (which would break the Vectorize index contract) fails loudly and safely
 * instead of writing vectors of the wrong size.
 */
export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimensions: number;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OpenAICompatibleEmbeddingProviderOptions) {
    if (typeof options.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(options.id)) throw new EmbeddingError();
    if (typeof options.baseUrl !== 'string' || options.baseUrl.length === 0) throw new EmbeddingError();
    if (typeof options.model !== 'string' || options.model.length === 0 || options.model.length > 128) throw new EmbeddingError();
    if (!Number.isInteger(options.dimensions) || options.dimensions < 1 || options.dimensions > 4096) throw new EmbeddingError();
    if (typeof options.apiKey !== 'string' || options.apiKey.length === 0) throw new EmbeddingError();
    this.id = options.id;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS;
  }

  async embed(inputs: readonly string[]): Promise<number[][]> {
    if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > MEMORY_MAX_EMBED_INPUTS) throw new EmbeddingError();
    for (const input of inputs) {
      if (typeof input !== 'string' || input.length === 0 || input.length > MAX_INPUT_CHARS) throw new EmbeddingError();
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${EMBEDDINGS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, input: [...inputs], encoding_format: 'float' }),
        signal: controller.signal,
      });
    } catch {
      // Timeout, abort, or transport failure — never the underlying detail.
      throw new EmbeddingError();
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) throw new EmbeddingError();

    let payload: unknown;
    try {
      const text = await response.text();
      if (text.length === 0 || text.length > MAX_RESPONSE_BYTES) throw new EmbeddingError();
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new EmbeddingError();
    }

    if (!isRecord(payload)) throw new EmbeddingError();
    const data = payload['data'];
    if (!Array.isArray(data) || data.length !== inputs.length) throw new EmbeddingError();

    const vectors: number[][] = [];
    for (const entry of data) {
      if (!isRecord(entry)) throw new EmbeddingError();
      const embedding = entry['embedding'];
      if (!Array.isArray(embedding) || embedding.length !== this.dimensions) throw new EmbeddingError();
      const values: number[] = [];
      for (const value of embedding) {
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new EmbeddingError();
        values.push(value);
      }
      vectors.push(values);
    }
    return vectors;
  }
}

/**
 * Deterministic local embedder — TESTS AND OFFLINE DEVELOPMENT ONLY.
 * Fixed 64 dimensions; no network, no credentials, exactly reproducible.
 * Explicitly NOT the production embedding system.
 */
export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'local-hash';
  readonly model = 'local-hash-trigram-ngram-v1';
  readonly dimensions = MEMORY_EMBEDDING_DIMENSIONS;

  async embed(inputs: readonly string[]): Promise<number[][]> {
    if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > MEMORY_MAX_EMBED_INPUTS) throw new EmbeddingError();
    return inputs.map((input) => {
      if (typeof input !== 'string' || input.length === 0 || input.length > MAX_INPUT_CHARS) throw new EmbeddingError();
      return embedTextLocal(input);
    });
  }
}

