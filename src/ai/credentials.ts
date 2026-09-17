import { unsealCredential } from './crypto';
import type { CredentialRow } from '../db/providers';
import { listCredentialsForProvider } from '../db/providers';

// Credential abstraction (Phase 4).
// The Agent Core never sees this module. Providers never manage keys: the
// router resolves a sealed row, decrypts it here with the master secret, and
// hands the adapter plaintext for a single attempt only.
//
// - Retrieval (`CredentialStore`) and decryption (`unsealCredential`) are
//   separate operations: normal configuration queries never return plaintext.
// - Rotation = insert a new row (new salt/IV), disable/remove the old row.
//   No code or redeploy is involved (Admin CMS owns the UI in Phase 8).

export interface StoredCredential {
  id: string;
  providerId: string;
  label: string;
  enabled: boolean;
  weight: number;
  /** Sealed envelope (v1.…). Plaintext is NEVER present on this object. */
  ciphertext: string;
}

export interface CredentialStore {
  listCredentials(providerId: string): Promise<StoredCredential[]>;
}

/** D1-backed store. Reads sealed envelopes only. */
export class D1CredentialStore implements CredentialStore {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async listCredentials(providerId: string): Promise<StoredCredential[]> {
    const rows: CredentialRow[] = await listCredentialsForProvider(this.db, providerId);
    return rows.map((row) => ({
      id: row.id,
      providerId: row.provider_id,
      label: row.label,
      enabled: row.enabled !== 0,
      weight: row.weight,
      ciphertext: row.secret_ciphertext,
    }));
  }
}

/** In-memory store for tests and for deployments without D1 persistence. */
export class StaticCredentialStore implements CredentialStore {
  private readonly credentials: StoredCredential[];

  constructor(credentials: StoredCredential[]) {
    this.credentials = credentials;
  }

  async listCredentials(providerId: string): Promise<StoredCredential[]> {
    return this.credentials.filter((credential) => credential.providerId === providerId);
  }
}

/**
 * Decrypts one sealed envelope. Fails closed with a generic error when the
 * master secret is missing, wrong, or the envelope was tampered with.
 */
export async function resolveCredentialPlaintext(ciphertext: string, masterSecret: string): Promise<string> {
  return unsealCredential(ciphertext, masterSecret);
}
