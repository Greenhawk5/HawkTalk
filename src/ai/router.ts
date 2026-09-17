import { ProviderError } from '../agent/errors';
import type { ModelProvider, ProviderGenerateInput, ProviderGenerateResult } from '../agent/provider';
import { listEnabledProviders, type ProviderRow } from '../db/providers';
import { OpenAICompatibleAdapter } from './adapter';
import { resolveCredentialPlaintext, type CredentialStore, type StoredCredential } from './credentials';

// AI Router (Phase 4): a ModelProvider that selects providers/credentials,
// applies health-gated ordering, and fails over on retryable failures.
// The Agent Core sees only the ModelProvider boundary.
//
// Model reference convention: "providerId:modelId" selects a provider
// explicitly (empty model part falls back to that provider's default_model).
// A bare "modelId" uses the highest-weight enabled provider. Provider ids
// must match [a-z0-9-] (no ':'), enforced when directory entries load.
//
// Failover policy (deterministic, bounded):
// - 429 → credential cools down, try next credential/provider.
// - 5xx / network failure / adapter timeout → try next (brief cooldown).
// - 401/403 → credential marked invalid (long cooldown), try next.
// - 400 / other 4xx / malformed provider result → abort, no failover.
// - Caller cancellation (input.signal aborted) → abort immediately.
// - Same credential is never retried within one call; attempts are capped.

export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
export const DEFAULT_SERVER_ERROR_COOLDOWN_MS = 30_000;
export const DEFAULT_INVALID_CREDENTIAL_COOLDOWN_MS = 3_600_000;
export const DEFAULT_MAX_ROUTER_ATTEMPTS = 8;
export const DEFAULT_ADAPTER_TIMEOUT_FALLBACK_MS = 30_000;
export const DEFAULT_MAX_CREDENTIAL_ATTEMPTS = 3;

export interface ProviderDirectoryEntry {
  id: string;
  baseUrl: string;
  weight: number;
  defaultModel: string;
  timeoutMs: number;
  maxCredentialAttempts: number;
}

export interface ProviderDirectory {
  listEnabledProviders(): Promise<ProviderDirectoryEntry[]>;
}

/** Routing health state. In-memory now; D1/Durable-Object backing later without core changes. */
export interface RouterHealth {
  cooledUntil(credentialId: string): number | undefined;
  cooldown(credentialId: string, untilMs: number): void;
}

export class InMemoryRouterHealth implements RouterHealth {
  private readonly until = new Map<string, number>();
  private readonly nowMs: () => number;

  constructor(nowMs: () => number = () => Date.now()) {
    this.nowMs = nowMs;
  }

  cooledUntil(credentialId: string): number | undefined {
    const until = this.until.get(credentialId);
    if (until === undefined) return undefined;
    if (until <= this.nowMs()) {
      this.until.delete(credentialId);
      return undefined;
    }
    return until;
  }

  cooldown(credentialId: string, untilMs: number): void {
    const current = this.until.get(credentialId);
    if (current === undefined || untilMs > current) this.until.set(credentialId, untilMs);
  }
}

/**
 * Deterministic key ordering: enabled, not cooled down, weight first,
 * id second. Future strategies (round-robin, weighted-random) replace this
 * function, not its callers.
 */
export function orderCredentials(credentials: StoredCredential[], health: RouterHealth, nowMs: number): StoredCredential[] {
  return credentials
    .filter((credential) => credential.enabled)
    .filter((credential) => {
      const until = health.cooledUntil(credential.id);
      return until === undefined || until <= nowMs;
    })
    .sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function isValidProviderId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9-]{1,64}$/.test(id);
}

function positiveIntOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Maps a D1 provider row to a directory entry; returns null for invalid rows. */
export function providerRowToEntry(row: ProviderRow): ProviderDirectoryEntry | null {
  if (!isValidProviderId(row.id)) return null;
  if (typeof row.base_url !== 'string' || row.base_url.length === 0) return null;
  if (typeof row.default_model !== 'string' || row.default_model.length === 0) return null;
  return {
    id: row.id,
    baseUrl: row.base_url,
    weight: positiveIntOr(row.weight, 100),
    defaultModel: row.default_model,
    timeoutMs: positiveIntOr(row.timeout_ms, DEFAULT_ADAPTER_TIMEOUT_FALLBACK_MS),
    maxCredentialAttempts: positiveIntOr(row.max_credential_attempts, DEFAULT_MAX_CREDENTIAL_ATTEMPTS),
  };
}

export class D1ProviderDirectory implements ProviderDirectory {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async listEnabledProviders(): Promise<ProviderDirectoryEntry[]> {
    const rows = await listEnabledProviders(this.db);
    const entries: ProviderDirectoryEntry[] = [];
    for (const row of rows) {
      const entry = providerRowToEntry(row);
      if (entry !== null) entries.push(entry);
    }
    return entries;
  }
}

export class StaticProviderDirectory implements ProviderDirectory {
  private readonly entries: ProviderDirectoryEntry[];

  constructor(entries: ProviderDirectoryEntry[]) {
    this.entries = entries;
  }

  async listEnabledProviders(): Promise<ProviderDirectoryEntry[]> {
    return [...this.entries]
      .filter((entry) => isValidProviderId(entry.id))
      .sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
}

export interface RouterCooldowns {
  rateLimitedMs?: number | undefined;
  serverErrorMs?: number | undefined;
  invalidCredentialMs?: number | undefined;
}

export interface RouterOptions {
  directory: ProviderDirectory;
  credentialStore: CredentialStore;
  health: RouterHealth;
  /** Dedicated master secret for credential decryption. Validated at construction. */
  masterSecret: string;
  fetchImpl?: typeof fetch | undefined;
  nowMs?: (() => number) | undefined;
  cooldowns?: RouterCooldowns | undefined;
  maxAttempts?: number | undefined;
}

interface ResolvedTarget {
  provider: ProviderDirectoryEntry;
  vendorModel: string;
  providers: ProviderDirectoryEntry[];
}

export class AIRouter implements ModelProvider {
  readonly id = 'router';
  private readonly directory: ProviderDirectory;
  private readonly credentialStore: CredentialStore;
  private readonly health: RouterHealth;
  private readonly masterSecret: string;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly nowMs: () => number;
  private readonly cooldowns: { rateLimitedMs: number; serverErrorMs: number; invalidCredentialMs: number };
  private readonly maxAttempts: number;

  constructor(options: RouterOptions) {
    if (typeof options.masterSecret !== 'string' || options.masterSecret.length === 0) {
      throw new Error('Credential master secret is not configured');
    }
    this.directory = options.directory;
    this.credentialStore = options.credentialStore;
    this.health = options.health;
    this.masterSecret = options.masterSecret;
    this.fetchImpl = options.fetchImpl;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.cooldowns = {
      rateLimitedMs: positiveIntOr(options.cooldowns?.rateLimitedMs, DEFAULT_RATE_LIMIT_COOLDOWN_MS),
      serverErrorMs: positiveIntOr(options.cooldowns?.serverErrorMs, DEFAULT_SERVER_ERROR_COOLDOWN_MS),
      invalidCredentialMs: positiveIntOr(options.cooldowns?.invalidCredentialMs, DEFAULT_INVALID_CREDENTIAL_COOLDOWN_MS),
    };
    this.maxAttempts = positiveIntOr(options.maxAttempts, DEFAULT_MAX_ROUTER_ATTEMPTS);
  }

  private resolveTarget(model: string, providers: ProviderDirectoryEntry[]): ResolvedTarget | null {
    const separator = model.indexOf(':');
    if (separator > 0) {
      const providerId = model.slice(0, separator);
      const remainder = model.slice(separator + 1);
      const provider = providers.find((entry) => entry.id === providerId);
      if (!provider) return null;
      return { provider, vendorModel: remainder.length > 0 ? remainder : provider.defaultModel, providers: [provider] };
    }
    if (providers.length === 0) return null;
    const first = providers[0] as ProviderDirectoryEntry;
    return { provider: first, vendorModel: model, providers };
  }

  async generate(input: ProviderGenerateInput): Promise<ProviderGenerateResult> {
    if (typeof input.model !== 'string' || input.model.length === 0 || input.model.startsWith(':')) {
      throw new ProviderError('malformed');
    }
    if (input.signal?.aborted === true) throw new ProviderError('timeout');

    const providers = await this.directory.listEnabledProviders().catch(() => [] as ProviderDirectoryEntry[]);
    const target = this.resolveTarget(input.model, providers);
    if (target === null) throw new ProviderError('unavailable');

    let attempts = 0;
    let lastError: ProviderError = new ProviderError('unavailable');

    for (const provider of target.providers) {
      const credentials = await this.credentialStore.listCredentials(provider.id).catch(() => [] as StoredCredential[]);
      const ordered = orderCredentials(credentials, this.health, this.nowMs());
      const budget = Math.min(provider.maxCredentialAttempts, ordered.length);
      for (let i = 0; i < budget; i += 1) {
        if (attempts >= this.maxAttempts) break;
        const credential = ordered[i] as StoredCredential;
        attempts += 1;

        let apiKey: string;
        try {
          apiKey = await resolveCredentialPlaintext(credential.ciphertext, this.masterSecret);
        } catch {
          this.health.cooldown(credential.id, this.nowMs() + this.cooldowns.invalidCredentialMs);
          lastError = new ProviderError('unavailable');
          continue;
        }

        const adapter = new OpenAICompatibleAdapter({
          id: provider.id,
          baseUrl: provider.baseUrl,
          apiKey,
          fetchImpl: this.fetchImpl,
          timeoutMs: provider.timeoutMs,
        });

        try {
          return await adapter.generate({ ...input, model: target.vendorModel });
        } catch (error) {
          if (!(error instanceof ProviderError)) {
            lastError = new ProviderError('upstream');
            continue;
          }
          lastError = error;
          const now = this.nowMs();
          if (error.code === 'malformed') throw error;
          if (error.code === 'timeout') {
            if (input.signal?.aborted) throw error;
            this.health.cooldown(credential.id, now + this.cooldowns.serverErrorMs);
            continue;
          }
          const status = error.httpStatus;
          if (status === 429) {
            this.health.cooldown(credential.id, now + this.cooldowns.rateLimitedMs);
            continue;
          }
          if (status === 401 || status === 403) {
            this.health.cooldown(credential.id, now + this.cooldowns.invalidCredentialMs);
            continue;
          }
          if (status !== undefined && status >= 500) {
            this.health.cooldown(credential.id, now + this.cooldowns.serverErrorMs);
            continue;
          }
          if (status === undefined) continue;
          throw error;
        }
      }
      if (attempts >= this.maxAttempts) break;
    }

    throw lastError;
  }
}
