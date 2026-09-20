// Phase 9 admin provider/credential management. Metadata only: these helpers
// never return secret_ciphertext. Mutations are guarded single-row updates.

import type { ProviderRow } from './providers';

export interface AdminCredentialMeta {
  id: string;
  providerId: string;
  label: string;
  enabled: boolean;
  weight: number;
  created_at: string;
}

export async function listAllProviders(db: D1Database): Promise<ProviderRow[]> {
  const result = await db.prepare('SELECT * FROM providers ORDER BY weight DESC, id ASC').all<ProviderRow>();
  return result.results;
}

export async function findProviderById(db: D1Database, providerId: string): Promise<ProviderRow | null> {
  const row = await db.prepare('SELECT * FROM providers WHERE id = ?').bind(providerId).first<Record<string, unknown>>();
  if (row === null) return null;
  return {
    id: String(row['id']),
    base_url: String(row['base_url']),
    enabled: Number(row['enabled']),
    weight: Number(row['weight']),
    default_model: String(row['default_model']),
    timeout_ms: Number(row['timeout_ms']),
    max_credential_attempts: Number(row['max_credential_attempts']),
    created_at: String(row['created_at']),
    updated_at: String(row['updated_at']),
  };
}

export async function listCredentialMetaForProvider(db: D1Database, providerId: string): Promise<AdminCredentialMeta[]> {
  const result = await db
    .prepare('SELECT id, provider_id, label, enabled, weight, created_at FROM provider_credentials WHERE provider_id = ? ORDER BY weight DESC, id ASC')
    .bind(providerId)
    .all<Record<string, unknown>>();
  return result.results.map((row) => ({
    id: String(row['id']),
    providerId: String(row['provider_id']),
    label: String(row['label']),
    enabled: Number(row['enabled']) !== 0,
    weight: Number(row['weight']),
    created_at: String(row['created_at']),
  }));
}

/** Metadata lookup by credential id (no ciphertext); null when missing. */
export async function findCredentialMetaById(db: D1Database, credentialId: string): Promise<AdminCredentialMeta | null> {
  const row = await db
    .prepare('SELECT id, provider_id, label, enabled, weight, created_at FROM provider_credentials WHERE id = ?')
    .bind(credentialId)
    .first<Record<string, unknown>>();
  if (row === null) return null;
  return {
    id: String(row['id']),
    providerId: String(row['provider_id']),
    label: String(row['label']),
    enabled: Number(row['enabled']) !== 0,
    weight: Number(row['weight']),
    created_at: String(row['created_at']),
  };
}

/** Enables/disables a provider; false when the provider is missing or already in the state. */
export async function setProviderEnabled(db: D1Database, providerId: string, enabled: boolean): Promise<boolean> {
  const result = await db
    .prepare('UPDATE providers SET enabled = ?, updated_at = updated_at WHERE id = ? AND enabled != ?')
    .bind(enabled ? 1 : 0, providerId, enabled ? 1 : 0)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function setCredentialEnabled(db: D1Database, credentialId: string, enabled: boolean): Promise<boolean> {
  const result = await db
    .prepare('UPDATE provider_credentials SET enabled = ?, updated_at = updated_at WHERE id = ? AND enabled != ?')
    .bind(enabled ? 1 : 0, credentialId, enabled ? 1 : 0)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Deletes a credential row (never its ciphertext content into any output). */
export async function deleteCredential(db: D1Database, credentialId: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM provider_credentials WHERE id = ?').bind(credentialId).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function countProviders(db: D1Database): Promise<{ total: number; enabled: number }> {
  const row = await db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(enabled != 0), 0) AS enabled FROM providers').first<{ total: number; enabled: number }>();
  return { total: row?.total ?? 0, enabled: row?.enabled ?? 0 };
}

export async function countCredentials(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS count FROM provider_credentials').first<{ count: number }>();
  return row?.count ?? 0;
}

// Provider/credential create/update mutations are executed exclusively through
// applyAdminMutation (src/db/admin-mutations.ts): one atomic batch that applies
// the mutation with the SQL-level ADMIN/OWNER actor guard and writes the audit
// record, rolling back together on failure. Do NOT add direct insert/update
// helpers here â€” they would create a second, non-atomic mutation path.
//
// The shared value shapes live in src/admin/provisioning.ts.
