import { AIRouter, D1ProviderDirectory, InMemoryRouterHealth } from '../ai/router';
import { D1CredentialStore } from '../ai/credentials';
import type { ModelProvider } from '../agent/provider';
import type { AppEnv } from '../env';

// Composition of the production ModelProvider (Phase 6 integration point).
// The AI Router remains the only provider-selection layer: the application
// layer constructs it here and hands the ModelProvider port to the flow.
// Credentials stay sealed in D1; the master secret lives in a Worker secret.
// Absent master secret → provider not constructed (transport-only mode).

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
