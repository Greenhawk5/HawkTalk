// Provider/credential provisioning value shapes + SQL builders, shared by the
// AdminService mutation path (src/db/admin-mutations.ts) and the local
// provisioning CLI (scripts/provision.mjs). Node-safe and Worker-safe: no Node
// built-ins, no D1 access, no secrets.
//
// IMPORTANT: relative imports here use explicit `.ts` extensions so this
// module (and its transitive imports) can also be loaded by
// `node --experimental-strip-types` from the provisioning CLI.

import { AdminError } from './errors.ts';
import {
  validateBaseUrl,
  validateCredentialLabel,
  validateCredentialWeight,
  validateDefaultModel,
  validateMaxCredentialAttempts,
  validateProviderId,
  validateTimeoutMs,
  validateWeight,
} from './provider-validation.ts';

export interface ProviderInsertParams {
  id: string;
  baseUrl: string;
  defaultModel: string;
  weight: number;
  timeoutMs: number;
  maxCredentialAttempts: number;
}

export interface ProviderUpdateFields {
  baseUrl?: string;
  defaultModel?: string;
  weight?: number;
  timeoutMs?: number;
  maxCredentialAttempts?: number;
}

export interface CredentialInsertParams {
  id: string;
  providerId: string;
  label: string;
  weight: number;
  sealedCiphertext: string;
}

/** Full validation for a provider-create request (shared by CMS and CLI). */
export function validateProviderParams(params: { id: unknown; baseUrl: unknown; defaultModel: unknown; weight: unknown; timeoutMs: unknown; maxCredentialAttempts: unknown }): ProviderInsertParams {
  validateProviderId(params.id);
  validateBaseUrl(params.baseUrl);
  validateDefaultModel(params.defaultModel);
  validateWeight(params.weight);
  validateTimeoutMs(params.timeoutMs);
  validateMaxCredentialAttempts(params.maxCredentialAttempts);
  return {
    id: params.id,
    baseUrl: params.baseUrl,
    defaultModel: params.defaultModel,
    weight: params.weight,
    timeoutMs: params.timeoutMs,
    maxCredentialAttempts: params.maxCredentialAttempts,
  };
}

/** Full validation for a credential-create request (shared by CMS and CLI). */
export function validateCredentialParams(params: { providerId: unknown; label: unknown; weight: unknown }): { providerId: string; label: string; weight: number } {
  validateProviderId(params.providerId);
  validateCredentialLabel(params.label);
  validateCredentialWeight(params.weight);
  return { providerId: params.providerId, label: params.label, weight: params.weight };
}

/** Generic validation failure with a CLI-friendly message. */
export function provisioningError(message: string): Error {
  return new AdminError('validation_failed', message);
}

/** SQL-escapes a literal for the generated provisioning statements. */
export function escapeSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** 64-bit random hex id, provider-prefixed for operator readability. */
export function newCredentialId(providerId: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${providerId}-${hex}`;
}

export function buildProviderInsertSql(params: ProviderInsertParams, createdAt: string): string {
  const esc = escapeSqlLiteral;
  return (
    'INSERT INTO providers (id, base_url, enabled, weight, default_model, timeout_ms, max_credential_attempts, created_at, updated_at) ' +
    `SELECT ${esc(params.id)}, ${esc(params.baseUrl)}, 1, ${Number(params.weight)}, ${esc(params.defaultModel)}, ${Number(params.timeoutMs)}, ${Number(params.maxCredentialAttempts)}, ${esc(createdAt)}, ${esc(createdAt)} ` +
    `WHERE NOT EXISTS (SELECT 1 FROM providers WHERE id = ${esc(params.id)});`
  );
}

export function buildCredentialInsertSql(params: CredentialInsertParams, createdAt: string): string {
  const esc = escapeSqlLiteral;
  return (
    'INSERT INTO provider_credentials (id, provider_id, label, enabled, weight, secret_ciphertext, created_at, updated_at) ' +
    `SELECT ${esc(params.id)}, ${esc(params.providerId)}, ${esc(params.label)}, 1, ${Number(params.weight)}, ${esc(params.sealedCiphertext)}, ${esc(createdAt)}, ${esc(createdAt)} ` +
    // Guard: a no-op unless the target provider exists.
    `WHERE EXISTS (SELECT 1 FROM providers WHERE id = ${esc(params.providerId)});`
  );
}