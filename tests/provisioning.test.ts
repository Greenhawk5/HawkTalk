// Provisioning CLI contract tests. FAKE credentials only — never real keys.
// The CLI (scripts/provision.mjs) shares validation and SQL building with the
// Worker via src/admin/provisioning.ts and seals with src/ai/crypto.ts.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { sealCredential, unsealCredential } from '../src/ai/crypto';
import {
  buildCredentialInsertSql,
  buildProviderInsertSql,
  escapeSqlLiteral,
  newCredentialId,
  validateCredentialParams,
  validateProviderParams,
} from '../src/admin/provisioning';

const FAKE_MASTER = 'provision-test-master-secret';
const FAKE_KEY = 'fake-provision-key-not-a-real-secret';

describe('provisioning SQL builders', () => {
  it('escapes single quotes in SQL literals', () => {
    expect(escapeSqlLiteral("o'brien")).toBe("'o''brien'");
  });

  it('builds a provider insert guarded against duplicates', () => {
    const sql = buildProviderInsertSql(
      { id: 'prov-x', baseUrl: 'https://api.example.com/v1', defaultModel: 'm1', weight: 100, timeoutMs: 30000, maxCredentialAttempts: 3 },
      '2026-09-19T00:00:00Z',
    );
    expect(sql).toContain('INSERT INTO providers');
    expect(sql).toContain('WHERE NOT EXISTS');
    expect(sql).not.toContain('secret');
  });

  it('builds a credential insert whose SQL contains only the sealed envelope, never plaintext', async () => {
    const sealed = await sealCredential(FAKE_KEY, FAKE_MASTER);
    const id = newCredentialId('prov-x');
    const sql = buildCredentialInsertSql(
      { id, providerId: 'prov-x', label: "label with 'quote'", weight: 100, sealedCiphertext: sealed },
      '2026-09-19T00:00:00Z',
    );
    expect(sql).toContain('INSERT INTO provider_credentials');
    expect(sql).toContain('WHERE EXISTS (SELECT 1 FROM providers WHERE id');
    expect(sql).not.toContain(FAKE_KEY);
    expect(sql).toContain(sealed);
    expect(sealed).toMatch(/^v1\./);
  });

  it('round-trips the sealed envelope the Worker can decrypt', async () => {
    const sealed = await sealCredential(FAKE_KEY, FAKE_MASTER);
    expect(await unsealCredential(sealed, FAKE_MASTER)).toBe(FAKE_KEY);
  });

  it('inserts a credential through the generated SQL and never stores plaintext', async () => {
    const sealed = await sealCredential(FAKE_KEY, FAKE_MASTER);
    const id = newCredentialId('prov-sql');
    await env.DB.prepare(
      "INSERT INTO providers (id, base_url, enabled, weight, default_model, timeout_ms, max_credential_attempts, created_at, updated_at) VALUES ('prov-sql', 'https://api.example.com/v1', 1, 100, 'm', 30000, 3, '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z')",
    ).run();
    const sql = buildCredentialInsertSql(
      { id, providerId: 'prov-sql', label: 'test key', weight: 100, sealedCiphertext: sealed },
      '2026-09-19T00:00:00Z',
    );
    await env.DB.prepare(sql).run();
    const row = await env.DB.prepare('SELECT secret_ciphertext FROM provider_credentials WHERE id = ?').bind(id).first<{ secret_ciphertext: string }>();
    expect(row?.secret_ciphertext).toMatch(/^v1\./);
    // The whole database must not contain the plaintext key anywhere.
    const all = await env.DB.prepare("SELECT '' FROM provider_credentials WHERE secret_ciphertext LIKE ?").bind(`%${FAKE_KEY}%`).first();
    expect(all).toBeNull();
  });
});

describe('provisioning validation (shared with Admin CMS)', () => {
  it('accepts a valid provider parameter set', () => {
    expect(validateProviderParams({ id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'anthropic/claude-sonnet-4', weight: 500, timeoutMs: 60000, maxCredentialAttempts: 3 })).toMatchObject({ id: 'openrouter', weight: 500 });
  });

  it('rejects invalid provider ids, non-https URLs, and private network targets', () => {
    expect(() => validateProviderParams({ id: 'Bad_ID', baseUrl: 'https://ok.example.com', defaultModel: 'm', weight: 100, timeoutMs: 30000, maxCredentialAttempts: 3 })).toThrow();
    expect(() => validateProviderParams({ id: 'p', baseUrl: 'http://api.example.com', defaultModel: 'm', weight: 100, timeoutMs: 30000, maxCredentialAttempts: 3 })).toThrow();
    expect(() => validateProviderParams({ id: 'p', baseUrl: 'https://169.254.169.254/', defaultModel: 'm', weight: 100, timeoutMs: 30000, maxCredentialAttempts: 3 })).toThrow();
  });

  it('rejects invalid credential labels and weights', () => {
    expect(() => validateCredentialParams({ providerId: 'p', label: '', weight: 100 })).toThrow();
    expect(() => validateCredentialParams({ providerId: 'p', label: 'ok', weight: 0 })).toThrow();
    expect(validateCredentialParams({ providerId: 'p', label: 'primary key', weight: 100 })).toMatchObject({ weight: 100 });
  });
});

describe('colon-bearing model ids (OpenRouter :free suffix)', () => {
  it('accepts a default model containing a colon in provider validation', () => {
    const params = validateProviderParams({
      id: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: 'thinkingmachines/inkling:free',
      weight: 100,
      timeoutMs: 30000,
      maxCredentialAttempts: 3,
    });
    expect(params.defaultModel).toBe('thinkingmachines/inkling:free');
  });

  it('persists the colon-bearing model verbatim in generated SQL', () => {
    const sql = buildProviderInsertSql(
      { id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'thinkingmachines/inkling:free', weight: 100, timeoutMs: 30000, maxCredentialAttempts: 3 },
      '2026-09-19T00:00:00Z',
    );
    expect(sql).toContain('thinkingmachines/inkling:free');
  });

  it('still rejects an empty model', () => {
    expect(() => validateProviderParams({
      id: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: '',
      weight: 100,
      timeoutMs: 30000,
      maxCredentialAttempts: 3,
    })).toThrow();
  });
});