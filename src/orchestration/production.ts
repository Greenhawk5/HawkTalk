import { AIRouter, D1ProviderDirectory, InMemoryRouterHealth } from '../ai/router';
import type { ProviderDirectory } from '../ai/router';
import { D1CredentialStore } from '../ai/credentials';
import type { ModelProvider } from '../agent/provider';
import type { AppEnv } from '../env';
import { recordUsageEvent } from '../db/usage';
import { buildResearchTools } from '../tools/research';
import { D1MemoryRepository } from '../db/memory';
import { WorkersAiEmbeddingProvider } from '../memory/workers-ai-embedding';
import { VectorizeAdapter } from '../memory/vectorize';
import { SemanticMemoryService } from '../memory/semantic-memory';
import type { MemoryRecallHook } from './service';

// Composition of the production ModelProvider (Phase 6 integration point).
// The AI Router remains the only provider-selection layer: the application
// layer constructs it here and hands the ModelProvider port to the flow.
// Credentials stay sealed in D1; the master secret lives in a Worker secret.
// Absent master secret → provider not constructed (transport-only mode).
//
// Phase 10 additions (additive only, no Phase 6 behavior changed):
// - The production router exposes its D1-backed provider directory through
//   the public ProviderDirectorySnapshot port so orchestration can resolve
//   routing profiles against the same directory the router uses — metadata
//   only (id/enabled/weight), no credentials, no base URLs.
// - Every flow installs a usage recorder: one idempotent usage_events row
//   per successful generation (failures record nothing; redelivery reuses
//   the assistant text and reuses the same event id, so no double-counting).
// - Research mode is supplied with the read-only web tools (web_search,
//   web_fetch) built through the existing tool factories; selection of the
//   RESEARCH profile happens in the Telegram layer via user commands.

export interface ProviderDirectorySnapshot {
  /** Non-secret routing metadata for profile resolution. */
  listRoutingProviders(): Promise<ReadonlyArray<{ id: string; enabled: boolean; weight: number }>>;
}

/** D1-backed snapshot: id/enabled/weight rows only — never credentials. */
export class D1ProviderDirectorySnapshot implements ProviderDirectorySnapshot {
  private readonly directory: ProviderDirectory;

  constructor(directory: ProviderDirectory) {
    this.directory = directory;
  }

  async listRoutingProviders(): Promise<ReadonlyArray<{ id: string; enabled: boolean; weight: number }>> {
    const entries = await this.directory.listEnabledProviders().catch(() => []);
    return entries.map((entry) => ({ id: entry.id, enabled: true, weight: entry.weight }));
  }
}

export function buildProductionProvider(db: D1Database, env: Partial<AppEnv>): ModelProvider | null {
  const masterSecret = env.CREDENTIAL_MASTER_SECRET;
  if (typeof masterSecret !== 'string' || masterSecret.length === 0) return null;
  return new AIRouter({
    directory: new D1ProviderDirectory(db),
    credentialStore: new D1CredentialStore(db),
    health: new InMemoryRouterHealth(),
    masterSecret,
  });
}

/**
 * Builds the production usage recorder for one internal user. The event id
 * is derived from the webhook request id, so a Telegram redelivery that
 * reuses the completed generation re-records the identical event id and the
 * INSERT OR IGNORE ledger keeps exactly one row.
 */
export function buildProductionUsageRecorder(
  db: D1Database,
  userId: number,
  requestId: string,
  now: () => string,
): { record(input: { providerId: string; vendorModel: string; requestId: string; inputTokens: number; outputTokens: number }): Promise<void> } {
  return {
    record: async (input) => {
      // Defense in depth: the ledger CHECKs reject bad shapes, but validate
      // here too so a malformed provider response can never become a row.
      if (!/^[a-z0-9-]{1,64}$/.test(input.providerId)) return;
      if (typeof input.vendorModel !== 'string' || input.vendorModel.length === 0 || input.vendorModel.length > 128) return;
      for (const tokens of [input.inputTokens, input.outputTokens]) {
        if (!Number.isSafeInteger(tokens) || tokens < 0 || tokens > 9007199254740991) return;
      }
      await recordUsageEvent(db, {
        id: `req:${requestId.slice(0, 100)}`,
        userId,
        providerId: input.providerId,
        vendorModel: input.vendorModel,
        requestId: input.requestId,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        createdAt: now(),
      }).catch(() => undefined);
    },
  };
}

export function buildProductionResearchTools(): ReturnType<typeof buildResearchTools> {
  return buildResearchTools();
}

export function buildProductionMemoryService(env: Partial<AppEnv>): SemanticMemoryService | null {
  if (!env.DB || typeof env.DB.prepare !== 'function') return null;
  if (!env.AI || typeof env.AI.run !== 'function') return null;
  if (!env.VECTORIZE || typeof env.VECTORIZE.upsert !== 'function') return null;
  try {
    const embeddings = new WorkersAiEmbeddingProvider({ ai: env.AI });
    const vectorIndex = new VectorizeAdapter({ index: env.VECTORIZE });
    const repo = new D1MemoryRepository(env.DB);
    return new SemanticMemoryService({ repo, embeddings, vectorIndex });
  } catch {
    return null;
  }
}

export function buildProductionMemoryRecall(env: Partial<AppEnv>, userId: number): MemoryRecallHook | undefined {
  const service = buildProductionMemoryService(env);
  if (service === null) return undefined;
  return async (query: string): Promise<string> => {
    const hits = await service.recall(userId, query);
    return service.renderContext(hits);
  };
}
