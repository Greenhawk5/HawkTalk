// Phase 4 data-access helpers for AI providers and credentials.
// Non-secret configuration only. These helpers NEVER decrypt: they return the
// sealed envelope for credentials, and decryption happens separately in
// src/ai/credentials.ts with the master secret (which never reaches D1 code).

export interface ProviderRow {
  id: string;
  base_url: string;
  enabled: number;
  weight: number;
  default_model: string;
  timeout_ms: number;
  max_credential_attempts: number;
  created_at: string;
  updated_at: string;
}

export interface CredentialRow {
  id: string;
  provider_id: string;
  label: string;
  enabled: number;
  weight: number;
  secret_ciphertext: string;
  created_at: string;
  updated_at: string;
}

/** Enabled providers, highest weight first (ties broken by id for determinism). */
export async function listEnabledProviders(db: D1Database): Promise<ProviderRow[]> {
  const result = await db
    .prepare('SELECT * FROM providers WHERE enabled != 0 ORDER BY weight DESC, id ASC')
    .all<ProviderRow>();
  return result.results;
}

/** All credential rows for a provider (enabled and disabled; the router filters). */
export async function listCredentialsForProvider(db: D1Database, providerId: string): Promise<CredentialRow[]> {
  const result = await db
    .prepare('SELECT * FROM provider_credentials WHERE provider_id = ? ORDER BY weight DESC, id ASC')
    .bind(providerId)
    .all<CredentialRow>();
  return result.results;
}
