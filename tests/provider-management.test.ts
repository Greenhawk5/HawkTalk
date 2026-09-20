import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { AdminService } from '../src/admin/service';
import { sealCredential, unsealCredential } from '../src/ai/crypto';
import { listAuditPage } from '../src/db/admin-audit';

const NOW = '2026-09-17T12:00:00.000Z';
const TEST_MASTER_SECRET = 'test-master-secret-provider-mgmt-phase';

async function seedUser(telegramId: number, role: string, status = 'active'): Promise<number> {
  await env.DB.prepare(
    "INSERT INTO users (telegram_user_id, username, display_name, status, role, created_at, updated_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(telegramId, `u${telegramId}`, `User ${telegramId}`, status, role, NOW, NOW, NOW)
    .run();
  const row = await env.DB.prepare('SELECT id FROM users WHERE telegram_user_id = ?').bind(telegramId).first<{ id: number }>();
  return row?.id ?? 0;
}

function makeSealFn() {
  return (plaintext: string) => sealCredential(plaintext, TEST_MASTER_SECRET);
}

let ownerId = 0;
let adminId = 0;
let vipId = 0;
let userId = 0;
let blockedId = 0;

beforeEach(async () => {
  ownerId = await seedUser(1000, 'OWNER');
  adminId = await seedUser(2000, 'ADMIN');
  vipId = await seedUser(3000, 'VIP');
  userId = await seedUser(4000, 'USER');
  blockedId = await seedUser(5000, 'BLOCKED');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService(): AdminService {
  return new AdminService(env.DB, () => NOW, makeSealFn());
}

function makeServiceWithoutSeal(): AdminService {
  return new AdminService(env.DB, () => NOW);
}

const VALID_PROVIDER = {
  id: 'test-provider',
  baseUrl: 'https://api.example.com/v1',
  defaultModel: 'gpt-4o',
};

async function createValidProvider(svc: AdminService, actor: number, overrides?: Record<string, unknown>): Promise<void> {
  await svc.createProvider(actor, { ...VALID_PROVIDER, ...overrides });
}

async function createProviderAndCredential(svc: AdminService, actor: number): Promise<void> {
  await svc.createProvider(actor, VALID_PROVIDER);
  await svc.createCredential(actor, {
    providerId: VALID_PROVIDER.id,
    label: 'Test Key',
    plaintextKey: 'fake-test-key-12345',
  });
}

// ===========================================================================
// 1. Provider creation
// ===========================================================================

describe('Provider creation', () => {
  it('creates provider with all valid params, verifiable via inspectProvider', async () => {
    const svc = makeService();
    await svc.createProvider(adminId, {
      id: 'full-provider',
      baseUrl: 'https://api.example.com/v1',
      defaultModel: 'claude-sonnet-4-20250514',
      weight: 200,
      timeoutMs: 60000,
      maxCredentialAttempts: 5,
    });
    const detail = await svc.inspectProvider(adminId, 'full-provider');
    expect(detail).toMatchObject({
      id: 'full-provider',
      baseUrl: 'https://api.example.com/v1',
      defaultModel: 'claude-sonnet-4-20250514',
      weight: 200,
      timeoutMs: 60000,
      maxCredentialAttempts: 5,
      enabled: true,
    });
  });

  it('creates provider with defaults (weight=100, timeoutMs=30000, maxCredentialAttempts=3)', async () => {
    const svc = makeService();
    await svc.createProvider(adminId, {
      id: 'default-provider',
      baseUrl: 'https://api.example.com/v1',
      defaultModel: 'gpt-4o',
    });
    const detail = await svc.inspectProvider(adminId, 'default-provider');
    expect(detail.weight).toBe(100);
    expect(detail.timeoutMs).toBe(30000);
    expect(detail.maxCredentialAttempts).toBe(3);
  });

  it('rejects duplicate provider ID with conflict error', async () => {
    const svc = makeService();
    await createValidProvider(svc, adminId);
    await expect(createValidProvider(svc, adminId)).rejects.toMatchObject({ kind: 'conflict' });
  });

  it.each([
    ['uppercase', 'Upper-Case'],
    ['special chars', 'my_provider!'],
    ['empty string', ''],
    ['too long (>64)', 'a'.repeat(65)],
    ['contains colon', 'my:provider'],
    ['contains space', 'my provider'],
    ['contains underscore', 'my_provider'],
  ])('rejects invalid provider ID: %s', async (_label, badId) => {
    const svc = makeService();
    await expect(
      svc.createProvider(adminId, { id: badId, baseUrl: 'https://api.example.com/v1', defaultModel: 'gpt-4o' }),
    ).rejects.toMatchObject({ kind: 'validation_failed' });
  });

  it.each([
    ['http scheme', 'http://api.example.com/v1'],
    ['empty string', ''],
    ['localhost', 'https://localhost/api'],
    ['127.0.0.1', 'https://127.0.0.1/api'],
    ['private 10.x', 'https://10.0.0.1/api'],
    ['private 192.168.x', 'https://192.168.1.1/api'],
    ['private 172.16.x', 'https://172.16.0.1/api'],
    ['private 172.31.x', 'https://172.31.255.1/api'],
    ['0.0.0.0', 'https://0.0.0.0/api'],
    ['metadata 169.254.x', 'https://169.254.169.254/latest/meta-data'],
    ['carrier NAT 100.64.x', 'https://100.64.0.1/api'],
    ['CGNAT upper 100.127.x', 'https://100.127.255.1/api'],
    ['subdomain localhost', 'https://api.localhost/v1'],
    ['IPv4-mapped IPv6 private', 'https://[::ffff:10.0.0.1]/v1'],
    ['IPv4-mapped loopback', 'https://[::ffff:127.0.0.1]/v1'],
    ['IPv6 loopback', 'https://[::1]/v1'],
    ['IPv6 ULA fc00::/7', 'https://[fc00::1]/v1'],
    ['IPv6 ULA fdff::/16', 'https://[fd12:3456::1]/v1'],
    ['IPv6 link-local fe80::/10', 'https://[fe80::1]/v1'],
    ['URL credentials', 'https://user:pass@api.example.com/v1'],
    ['invalid octets', 'https://999.1.1.1/api'],
  ])('rejects invalid base URL: %s', async (_label, badUrl) => {
    const svc = makeService();
    await expect(
      svc.createProvider(adminId, { id: 'test-prov', baseUrl: badUrl, defaultModel: 'gpt-4o' }),
    ).rejects.toMatchObject({ kind: 'validation_failed' });
  });

  it.each([
    ['empty string', ''],
    ['too long (>128)', 'm'.repeat(129)],
  ])('rejects invalid default model: %s', async (_label, badModel) => {
    const svc = makeService();
    await expect(
      svc.createProvider(adminId, { id: 'test-prov', baseUrl: 'https://api.example.com/v1', defaultModel: badModel }),
    ).rejects.toMatchObject({ kind: 'validation_failed' });
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['too large (>10000)', 10001],
    ['float', 50.5],
  ])('rejects invalid weight: %s', async (_label, badWeight) => {
    const svc = makeService();
    await expect(
      svc.createProvider(adminId, { id: 'test-prov', baseUrl: 'https://api.example.com/v1', defaultModel: 'gpt-4o', weight: badWeight }),
    ).rejects.toMatchObject({ kind: 'validation_failed' });
  });

  it.each([
    ['too low (<1000)', 999],
    ['too high (>120000)', 120001],
  ])('rejects invalid timeout: %s', async (_label, badTimeout) => {
    const svc = makeService();
    await expect(
      svc.createProvider(adminId, { id: 'test-prov', baseUrl: 'https://api.example.com/v1', defaultModel: 'gpt-4o', timeoutMs: badTimeout }),
    ).rejects.toMatchObject({ kind: 'validation_failed' });
  });

  it.each([
    ['too low (<1)', 0],
    ['too high (>10)', 11],
  ])('rejects invalid max_credential_attempts: %s', async (_label, badAttempts) => {
    const svc = makeService();
    await expect(
      svc.createProvider(adminId, { id: 'test-prov', baseUrl: 'https://api.example.com/v1', defaultModel: 'gpt-4o', maxCredentialAttempts: badAttempts }),
    ).rejects.toMatchObject({ kind: 'validation_failed' });
  });
});

// ===========================================================================
// 2. Provider update
// ===========================================================================

describe('Provider update', () => {
  it('updates a single field and preserves others', async () => {
    const svc = makeService();
    await svc.createProvider(adminId, {
      id: 'update-test',
      baseUrl: 'https://api.example.com/v1',
      defaultModel: 'gpt-4o',
      weight: 100,
      timeoutMs: 30000,
    });
    await svc.updateProvider(adminId, 'update-test', { weight: 500 });
    const detail = await svc.inspectProvider(adminId, 'update-test');
    expect(detail.weight).toBe(500);
    expect(detail.baseUrl).toBe('https://api.example.com/v1');
    expect(detail.defaultModel).toBe('gpt-4o');
    expect(detail.timeoutMs).toBe(30000);
  });

  it('updates multiple fields at once', async () => {
    const svc = makeService();
    await createValidProvider(svc, adminId, { id: 'multi-update' });
    await svc.updateProvider(adminId, 'multi-update', {
      baseUrl: 'https://new-api.example.com/v2',
      defaultModel: 'claude-opus-4-20250514',
      weight: 999,
      timeoutMs: 60000,
      maxCredentialAttempts: 7,
    });
    const detail = await svc.inspectProvider(adminId, 'multi-update');
    expect(detail.baseUrl).toBe('https://new-api.example.com/v2');
    expect(detail.defaultModel).toBe('claude-opus-4-20250514');
    expect(detail.weight).toBe(999);
    expect(detail.timeoutMs).toBe(60000);
    expect(detail.maxCredentialAttempts).toBe(7);
  });

  it('rejects update to nonexistent provider with not_found', async () => {
    const svc = makeService();
    await expect(
      svc.updateProvider(adminId, 'does-not-exist', { weight: 200 }),
    ).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('rejects empty update (no fields)', async () => {
    const svc = makeService();
    await createValidProvider(svc, adminId);
    await expect(
      svc.updateProvider(adminId, VALID_PROVIDER.id, {}),
    ).rejects.toMatchObject({ kind: 'validation_failed' });
  });

  it('validates updated values same as creation', async () => {
    const svc = makeService();
    await createValidProvider(svc, adminId);
    await expect(
      svc.updateProvider(adminId, VALID_PROVIDER.id, { baseUrl: 'http://insecure.com' }),
    ).rejects.toMatchObject({ kind: 'validation_failed' });
    await expect(
      svc.updateProvider(adminId, VALID_PROVIDER.id, { defaultModel: '' }),
    ).rejects.toMatchObject({ kind: 'validation_failed' });
    await expect(
      svc.updateProvider(adminId, VALID_PROVIDER.id, { weight: 0 }),
    ).rejects.toMatchObject({ kind: 'validation_failed' });
    await expect(
      svc.updateProvider(adminId, VALID_PROVIDER.id, { timeoutMs: 500 }),
    ).rejects.toMatchObject({ kind: 'validation_failed' });
    await expect(
      svc.updateProvider(adminId, VALID_PROVIDER.id, { maxCredentialAttempts: 99 }),
    ).rejects.toMatchObject({ kind: 'validation_failed' });
  });
});

// ===========================================================================
// 3. Provider enable/disable
// ===========================================================================

describe('Provider enable/disable', () => {
  it('setProviderEnabled works alongside create/update', async () => {
    const svc = makeService();
    await createValidProvider(svc, adminId);
    const before = await svc.inspectProvider(adminId, VALID_PROVIDER.id);
    expect(before.enabled).toBe(true);
    await svc.setProviderEnabled(adminId, VALID_PROVIDER.id, false);
    const after = await svc.inspectProvider(adminId, VALID_PROVIDER.id);
    expect(after.enabled).toBe(false);
  });

  it('disable then re-enable', async () => {
    const svc = makeService();
    await createValidProvider(svc, adminId);
    await svc.setProviderEnabled(adminId, VALID_PROVIDER.id, false);
    expect((await svc.inspectProvider(adminId, VALID_PROVIDER.id)).enabled).toBe(false);
    await svc.setProviderEnabled(adminId, VALID_PROVIDER.id, true);
    expect((await svc.inspectProvider(adminId, VALID_PROVIDER.id)).enabled).toBe(true);
  });
});

// ===========================================================================
// 4. Credential creation
// ===========================================================================

describe('Credential creation', () => {
  it('creates credential and stores encrypted ciphertext starting with v1.', async () => {
    const svc = makeService();
    await createValidProvider(svc, adminId);
    await svc.createCredential(adminId, {
      providerId: VALID_PROVIDER.id,
      label: 'My Key',
      plaintextKey: 'fake-test-key-openrouter-12345',
    });
    const row = await env.DB.prepare(
      'SELECT secret_ciphertext FROM provider_credentials WHERE provider_id = ?',
    ).bind(VALID_PROVIDER.id).first<{ secret_ciphertext: string }>();
    expect(row).not.toBeNull();
    expect(row!.secret_ciphertext).toMatch(/^v1\./);
  });

  it('created credential is decryptable with same master secret via unsealCredential', async () => {
    const svc = makeService();
    await createValidProvider(svc, adminId);
    const originalKey = 'fake-test-key-decrypt-check-99999';
    await svc.createCredential(adminId, {
      providerId: VALID_PROVIDER.id,
      label: 'Decrypt Test',
      plaintextKey: originalKey,
    });
    const row = await env.DB.prepare(
      'SELECT secret_ciphertext FROM provider_credentials WHERE provider_id = ?',
    ).bind(VALID_PROVIDER.id).first<{ secret_ciphertext: string }>();
    const decrypted = await unsealCredential(row!.secret_ciphertext, TEST_MASTER_SECRET);
    expect(decrypted).toBe(originalKey);
  });

  it('plaintext key never appears in D1 raw rows', async () => {
    const svc = makeService();
    await createValidProvider(svc, adminId);
    const sensitivePlaintext = 'super-secret-fake-key-never-stored-plain-xyzzy';
    await svc.createCredential(adminId, {
      providerId: VALID_PROVIDER.id,
      label: 'Plaintext Check',
      plaintextKey: sensitivePlaintext,
    });
    const allRows = await env.DB.prepare(
      'SELECT * FROM provider_credentials WHERE provider_id = ?',
    ).bind(VALID_PROVIDER.id).all();
    for (const row of allRows.results) {
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain(sensitivePlaintext);
    }
  });

  it('rejects empty plaintext key', async () => {
    const svc = makeService();
    await createValidProvider(svc, adminId);
    await expect(
      svc.createCredential(adminId, {
        providerId: VALID_PROVIDER.id,
        label: 'Empty Key',
        plaintextKey: '',
      }),
    ).rejects.toMatchObject({ kind: 'validation_failed' });
  });

  it('rejects missing sealFn (AdminService constructed without sealFn)', async () => {
    const svcNoSeal = makeServiceWithoutSeal();
    const svcWithSeal = makeService();
    await createValidProvider(svcWithSeal, adminId);
    await expect(
      svcNoSeal.createCredential(adminId, {
        providerId: VALID_PROVIDER.id,
        label: 'No Seal',
        plaintextKey: 'fake-key-no-seal',
      }),
    ).rejects.toMatchObject({ kind: 'storage_failed' });
  });

  it('rejects credential for nonexistent provider', async () => {
    const svc = makeService();
    await expect(
      svc.createCredential(adminId, {
        providerId: 'nonexistent-provider',
        label: 'Orphan Cred',
        plaintextKey: 'fake-key-orphan',
      }),
    ).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('generates unique credential IDs', async () => {
    const svc = makeService();
    await createValidProvider(svc, adminId);
    await svc.createCredential(adminId, {
      providerId: VALID_PROVIDER.id,
      label: 'Key A',
      plaintextKey: 'fake-key-a-unique-test',
    });
    // Small delay to ensure Date.now() differs
    await new Promise((r) => setTimeout(r, 5));
    await svc.createCredential(adminId, {
      providerId: VALID_PROVIDER.id,
      label: 'Key B',
      plaintextKey: 'fake-key-b-unique-test',
    });
    const rows = await env.DB.prepare(
      'SELECT id FROM provider_credentials WHERE provider_id = ?',
    ).bind(VALID_PROVIDER.id).all<{ id: string }>();
    const ids = rows.results.map((r) => r.id);
    expect(ids.length).toBe(2);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

// ===========================================================================
// 5. Multiple credentials per provider
// ===========================================================================

describe('Multiple credentials per provider', () => {
  it('creates 3 credentials for one provider, all appear in inspectProvider', async () => {
    const svc = makeService();
    await createValidProvider(svc, adminId);
    for (let i = 0; i < 3; i++) {
      await svc.createCredential(adminId, {
        providerId: VALID_PROVIDER.id,
        label: `Key ${i}`,
        plaintextKey: `fake-multi-key-${i}-abcdef`,
        weight: 100 + i,
      });
      // Ensure distinct timestamps for unique IDs
      if (i < 2) await new Promise((r) => setTimeout(r, 5));
    }
    const detail = await svc.inspectProvider(adminId, VALID_PROVIDER.id);
    expect(detail.credentials).toHaveLength(3);
    const labels = detail.credentials.map((c) => c.label);
    expect(labels).toContain('Key 0');
    expect(labels).toContain('Key 1');
    expect(labels).toContain('Key 2');
  });

  it('each has distinct ciphertext even with same plaintext key', async () => {
    const svc = makeService();
    await createValidProvider(svc, adminId);
    const sameKey = 'fake-identical-key-for-all-three';
    for (let i = 0; i < 3; i++) {
      await svc.createCredential(adminId, {
        providerId: VALID_PROVIDER.id,
        label: `Same Key ${i}`,
        plaintextKey: sameKey,
      });
      if (i < 2) await new Promise((r) => setTimeout(r, 5));
    }
    const rows = await env.DB.prepare(
      'SELECT secret_ciphertext FROM provider_credentials WHERE provider_id = ? ORDER BY created_at ASC',
    ).bind(VALID_PROVIDER.id).all<{ secret_ciphertext: string }>();
    const ciphertexts = rows.results.map((r) => r.secret_ciphertext);
    expect(ciphertexts.length).toBe(3);
    // All three must be distinct (different salt/IV per seal)
    expect(new Set(ciphertexts).size).toBe(3);
  });

  it('weight ordering is preserved in inspectProvider', async () => {
    const svc = makeService();
    await createValidProvider(svc, adminId);
    // Insert with specific weights; listCredentialMetaForProvider orders by weight DESC
    await svc.createCredential(adminId, {
      providerId: VALID_PROVIDER.id,
      label: 'Low Weight',
      plaintextKey: 'fake-low-weight-key',
      weight: 10,
    });
    await new Promise((r) => setTimeout(r, 5));
    await svc.createCredential(adminId, {
      providerId: VALID_PROVIDER.id,
      label: 'High Weight',
      plaintextKey: 'fake-high-weight-key',
      weight: 900,
    });
    await new Promise((r) => setTimeout(r, 5));
    await svc.createCredential(adminId, {
      providerId: VALID_PROVIDER.id,
      label: 'Mid Weight',
      plaintextKey: 'fake-mid-weight-key',
      weight: 500,
    });
    const detail = await svc.inspectProvider(adminId, VALID_PROVIDER.id);
    expect(detail.credentials).toHaveLength(3);
    // Ordered by weight DESC
    expect(detail.credentials[0]!.weight).toBe(900);
    expect(detail.credentials[1]!.weight).toBe(500);
    expect(detail.credentials[2]!.weight).toBe(10);
  });
});

// ===========================================================================
// 6. Credential enable/disable
// ===========================================================================

describe('Credential enable/disable', () => {
  it('setCredentialEnabled works on newly created credentials', async () => {
    const svc = makeService();
    await createValidProvider(svc, adminId);
    await svc.createCredential(adminId, {
      providerId: VALID_PROVIDER.id,
      label: 'Toggle Key',
      plaintextKey: 'fake-toggle-key-12345',
    });
    const detail = await svc.inspectProvider(adminId, VALID_PROVIDER.id);
    const credId = detail.credentials[0]!.id;
    expect(detail.credentials[0]!.enabled).toBe(true);

    await svc.setCredentialEnabled(adminId, credId, false);
    const afterDisable = await svc.inspectProvider(adminId, VALID_PROVIDER.id);
    expect(afterDisable.credentials[0]!.enabled).toBe(false);

    await svc.setCredentialEnabled(adminId, credId, true);
    const afterEnable = await svc.inspectProvider(adminId, VALID_PROVIDER.id);
    expect(afterEnable.credentials[0]!.enabled).toBe(true);
  });
});

// ===========================================================================
// 7. Credential deletion
// ===========================================================================

describe('Credential deletion', () => {
  it('OWNER can delete credentials', async () => {
    const svc = makeService();
    await createValidProvider(svc, ownerId);
    await svc.createCredential(ownerId, {
      providerId: VALID_PROVIDER.id,
      label: 'Owner Delete Key',
      plaintextKey: 'fake-owner-delete-key',
    });
const detail = await svc.inspectProvider(ownerId, VALID_PROVIDER.id);
    const credId = detail.credentials[0]!.id;

    await svc.deleteCredential(ownerId, credId);
    const afterDelete = await svc.inspectProvider(ownerId, VALID_PROVIDER.id);
    expect(afterDelete.credentials).toHaveLength(0);

    const countRow = await env.DB.prepare('SELECT COUNT(*) AS n FROM provider_credentials').first<{ n: number }>();
    expect(countRow?.n).toBe(0);
  });

  it('ADMIN cannot delete credentials (not_authorized)', async () => {
    const svc = makeService();
    await createValidProvider(svc, adminId);
    await svc.createCredential(adminId, {
      providerId: VALID_PROVIDER.id,
      label: 'Admin No Delete',
      plaintextKey: 'fake-admin-no-delete-key',
    });
const detail = await svc.inspectProvider(adminId, VALID_PROVIDER.id);
    const credId = detail.credentials[0]!.id;

    await expect(svc.deleteCredential(adminId, credId)).rejects.toMatchObject({ kind: 'not_authorized' });

    // Verify credential still exists
    const afterAttempt = await svc.inspectProvider(adminId, VALID_PROVIDER.id);
    expect(afterAttempt.credentials).toHaveLength(1);
  });
});

// ===========================================================================
// 8. RBAC restrictions
// ===========================================================================

describe('RBAC restrictions', () => {
  it('ADMIN can create providers and credentials', async () => {
    const svc = makeService();
    await expect(
      svc.createProvider(adminId, { id: 'admin-prov', baseUrl: 'https://api.example.com/v1', defaultModel: 'gpt-4o' }),
    ).resolves.toBeUndefined();
    await expect(
      svc.createCredential(adminId, { providerId: 'admin-prov', label: 'Admin Cred', plaintextKey: 'fake-admin-rbac-key' }),
    ).resolves.toBeUndefined();
  });

  it('OWNER can create providers and credentials', async () => {
    const svc = makeService();
    await expect(
      svc.createProvider(ownerId, { id: 'owner-prov', baseUrl: 'https://api.example.com/v1', defaultModel: 'gpt-4o' }),
    ).resolves.toBeUndefined();
    await expect(
      svc.createCredential(ownerId, { providerId: 'owner-prov', label: 'Owner Cred', plaintextKey: 'fake-owner-rbac-key' }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['VIP', () => vipId],
    ['USER', () => userId],
    ['BLOCKED', () => blockedId],
  ])('%s cannot create providers or credentials (not_authorized)', async (_role, getId) => {
    const svc = makeService();
    const actorId = getId();
    await expect(
      svc.createProvider(actorId, { id: 'denied-prov', baseUrl: 'https://api.example.com/v1', defaultModel: 'gpt-4o' }),
    ).rejects.toMatchObject({ kind: 'not_authorized' });
    // Seed a provider so we can test credential creation denial
    await createValidProvider(svc, adminId);
    await expect(
      svc.createCredential(actorId, { providerId: VALID_PROVIDER.id, label: 'Denied', plaintextKey: 'fake-denied-key' }),
    ).rejects.toMatchObject({ kind: 'not_authorized' });
  });
});

// ===========================================================================
// 9. Audit logging
// ===========================================================================

describe('Audit logging', () => {
  it('createProvider records audit without secrets', async () => {
    const svc = makeService();
    await createValidProvider(svc, adminId);
    const page = await listAuditPage(env.DB, null, 5);
    expect(page.records.length).toBeGreaterThanOrEqual(1);
    const record = page.records.find((r) => r.action === 'providers.create');
    expect(record).toBeDefined();
    expect(record!.targetType).toBe('provider');
    expect(record!.targetId).toBe(VALID_PROVIDER.id);
    expect(record!.success).toBe(true);
    expect(record!.actorRole).toBe('ADMIN');
    const detail = JSON.parse(record!.detail);
    expect(detail.base_url).toBe(VALID_PROVIDER.baseUrl);
    expect(detail.default_model).toBe(VALID_PROVIDER.defaultModel);
    // Must not contain any secret material
    expect(JSON.stringify(detail)).not.toContain('key');
    expect(JSON.stringify(detail)).not.toContain('secret');
    expect(JSON.stringify(detail)).not.toContain('credential');
  });

  it('createCredential audit detail contains only providerId and label, never ciphertext or plaintext', async () => {
    const svc = makeService();
    await createValidProvider(svc, adminId);
    const fakeKey = 'fake-audit-never-leaked-key-xyzzy';
    await svc.createCredential(adminId, {
      providerId: VALID_PROVIDER.id,
      label: 'Audit Cred Label',
      plaintextKey: fakeKey,
    });
    const page = await listAuditPage(env.DB, null, 10);
    const record = page.records.find((r) => r.action === 'credentials.create');
    expect(record).toBeDefined();
    expect(record!.success).toBe(true);
    const detail = JSON.parse(record!.detail);
    expect(detail.provider_id).toBe(VALID_PROVIDER.id);
    expect(detail.label).toBe('Audit Cred Label');
    // Must never contain the plaintext key or any sealed data
    const detailStr = JSON.stringify(detail);
    expect(detailStr).not.toContain(fakeKey);
    expect(detailStr).not.toContain('v1.');
    expect(detailStr).not.toContain('ciphertext');
    expect(detailStr).not.toContain('secret');
  });

  it('updateProvider records audit', async () => {
    const svc = makeService();
    await createValidProvider(svc, adminId);
    await svc.updateProvider(adminId, VALID_PROVIDER.id, { weight: 777 });
    const page = await listAuditPage(env.DB, null, 10);
    const record = page.records.find((r) => r.action === 'providers.update');
    expect(record).toBeDefined();
    expect(record!.targetId).toBe(VALID_PROVIDER.id);
    expect(record!.success).toBe(true);
    const detail = JSON.parse(record!.detail);
    expect(detail.fields).toContain('weight');
  });
});

// ===========================================================================
// 10. Secret non-disclosure
// ===========================================================================

describe('Secret non-disclosure', () => {
  it('listProviders never includes ciphertext', async () => {
    const svc = makeService();
    await createProviderAndCredential(svc, adminId);
    const providers = await svc.listProviders(adminId);
    const serialized = JSON.stringify(providers);
    expect(serialized).not.toContain('v1.');
    expect(serialized).not.toContain('ciphertext');
    expect(serialized).not.toContain('secret');
  });

  it('inspectProvider never includes ciphertext', async () => {
    const svc = makeService();
    await createProviderAndCredential(svc, adminId);
    const detail = await svc.inspectProvider(adminId, VALID_PROVIDER.id);
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain('v1.');
    expect(serialized).not.toContain('ciphertext');
    expect(serialized).not.toContain('secret_ciphertext');
  });

  it('inspectCredential never includes ciphertext', async () => {
    const svc = makeService();
    await createValidProvider(svc, adminId);
    await svc.createCredential(adminId, {
      providerId: VALID_PROVIDER.id,
      label: 'Inspect Me',
      plaintextKey: 'fake-inspect-nondisclose-key',
    });
const detail = await svc.inspectProvider(adminId, VALID_PROVIDER.id);
    const credId = detail.credentials[0]!.id;
    const meta = await svc.inspectCredential(adminId, credId);
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain('v1.');
    expect(serialized).not.toContain('ciphertext');
    expect(serialized).not.toContain('secret');
    // Meta should only have safe fields
    expect(meta).toHaveProperty('id');
    expect(meta).toHaveProperty('label');
    expect(meta).toHaveProperty('enabled');
    expect(meta).toHaveProperty('weight');
  });

  it('JSON.stringify of any admin response never contains v1. sealed data', async () => {
    const svc = makeService();
    await createProviderAndCredential(svc, adminId);

    const listResult = await svc.listProviders(adminId);
    expect(JSON.stringify(listResult)).not.toContain('v1.');

    const inspectProvResult = await svc.inspectProvider(adminId, VALID_PROVIDER.id);
    expect(JSON.stringify(inspectProvResult)).not.toContain('v1.');

const credId = inspectProvResult.credentials[0]!.id;
    const inspectCredResult = await svc.inspectCredential(adminId, credId);
    expect(JSON.stringify(inspectCredResult)).not.toContain('v1.');

    const dashboardResult = await svc.getDashboard(adminId);
    expect(JSON.stringify(dashboardResult)).not.toContain('v1.');
  });
});

// ===========================================================================
// 11. Routing integration
// ===========================================================================

describe('Routing integration', () => {
  it('D1 rows are correct for router consumption after creating provider+credential', async () => {
    const svc = makeService();
    await svc.createProvider(adminId, {
      id: 'router-prov',
      baseUrl: 'https://router-api.example.com/v1',
      defaultModel: 'router-model-v1',
      weight: 250,
      timeoutMs: 45000,
      maxCredentialAttempts: 4,
    });
    await svc.createCredential(adminId, {
      providerId: 'router-prov',
      label: 'Router Key',
      plaintextKey: 'fake-router-integration-key-abcde',
      weight: 300,
    });

    // Verify provider row directly
    const provRow = await env.DB.prepare('SELECT * FROM providers WHERE id = ?').bind('router-prov').first<Record<string, unknown>>();
    expect(provRow).not.toBeNull();
    expect(provRow!['base_url']).toBe('https://router-api.example.com/v1');
    expect(provRow!['default_model']).toBe('router-model-v1');
    expect(provRow!['weight']).toBe(250);
    expect(provRow!['timeout_ms']).toBe(45000);
    expect(provRow!['max_credential_attempts']).toBe(4);
    expect(provRow!['enabled']).toBe(1);

    // Verify credential row directly
    const credRow = await env.DB.prepare('SELECT * FROM provider_credentials WHERE provider_id = ?').bind('router-prov').first<Record<string, unknown>>();
    expect(credRow).not.toBeNull();
    expect(credRow!['provider_id']).toBe('router-prov');
    expect(credRow!['label']).toBe('Router Key');
    expect(credRow!['weight']).toBe(300);
    expect(credRow!['enabled']).toBe(1);
    expect(String(credRow!['secret_ciphertext'])).toMatch(/^v1\./);

    // Verify the ciphertext is decryptable (the router would unseal it at runtime)
    const decrypted = await unsealCredential(String(credRow!['secret_ciphertext']), TEST_MASTER_SECRET);
    expect(decrypted).toBe('fake-router-integration-key-abcde');
  });

  it('multiple providers with credentials are all visible in D1 for routing', async () => {
    const svc = makeService();
    await svc.createProvider(adminId, { id: 'prov-alpha', baseUrl: 'https://alpha.example.com/v1', defaultModel: 'model-a', weight: 100 });
    await svc.createProvider(adminId, { id: 'prov-beta', baseUrl: 'https://beta.example.com/v1', defaultModel: 'model-b', weight: 200 });
    await svc.createCredential(adminId, { providerId: 'prov-alpha', label: 'Alpha Key', plaintextKey: 'fake-alpha-routing-key' });
    await svc.createCredential(adminId, { providerId: 'prov-beta', label: 'Beta Key', plaintextKey: 'fake-beta-routing-key' });

    const providers = await env.DB.prepare('SELECT id, weight FROM providers ORDER BY weight DESC').all<{ id: string; weight: number }>();
    expect(providers.results.length).toBeGreaterThanOrEqual(2);
    const ids = providers.results.map((r) => r.id);
    expect(ids).toContain('prov-alpha');
    expect(ids).toContain('prov-beta');

    // Beta should come first due to higher weight
    const betaIdx = ids.indexOf('prov-beta');
    const alphaIdx = ids.indexOf('prov-alpha');
    expect(betaIdx).toBeLessThan(alphaIdx);
  });
});

// ===========================================================================
// 12. Provider configurations
// ===========================================================================

describe('Provider configurations', () => {
  it('OpenRouter config: creates provider with OpenRouter URL, verifies stored correctly', async () => {
    const svc = makeService();
    await svc.createProvider(adminId, {
      id: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: 'anthropic/claude-sonnet-4',
      weight: 500,
      timeoutMs: 60000,
    });
    const detail = await svc.inspectProvider(adminId, 'openrouter');
    expect(detail.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(detail.defaultModel).toBe('anthropic/claude-sonnet-4');
    expect(detail.weight).toBe(500);
    expect(detail.timeoutMs).toBe(60000);

    // Verify directly in D1
    const row = await env.DB.prepare('SELECT base_url, default_model FROM providers WHERE id = ?')
      .bind('openrouter')
      .first<{ base_url: string; default_model: string }>();
    expect(row!.base_url).toBe('https://openrouter.ai/api/v1');
    expect(row!.default_model).toBe('anthropic/claude-sonnet-4');
  });

  it('Z.AI config: creates provider with Z.AI URL, verifies stored correctly', async () => {
    const svc = makeService();
    await svc.createProvider(adminId, {
      id: 'z-ai',
      baseUrl: 'https://api.z.ai/api/v1',
      defaultModel: 'glm-4-plus',
      weight: 300,
    });
    const detail = await svc.inspectProvider(adminId, 'z-ai');
    expect(detail.baseUrl).toBe('https://api.z.ai/api/v1');
    expect(detail.defaultModel).toBe('glm-4-plus');

    const row = await env.DB.prepare('SELECT base_url FROM providers WHERE id = ?')
      .bind('z-ai')
      .first<{ base_url: string }>();
    expect(row!.base_url).toBe('https://api.z.ai/api/v1');
  });

  it('Gemini OpenAI-compatible: creates provider with Gemini URL, verifies stored correctly', async () => {
    const svc = makeService();
    await svc.createProvider(adminId, {
      id: 'gemini-compat',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      defaultModel: 'gemini-2.5-pro',
      weight: 400,
      timeoutMs: 90000,
    });
    const detail = await svc.inspectProvider(adminId, 'gemini-compat');
    expect(detail.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta/openai');
    expect(detail.defaultModel).toBe('gemini-2.5-pro');
    expect(detail.timeoutMs).toBe(90000);

    const row = await env.DB.prepare('SELECT base_url, default_model, timeout_ms FROM providers WHERE id = ?')
      .bind('gemini-compat')
      .first<{ base_url: string; default_model: string; timeout_ms: number }>();
    expect(row!.base_url).toBe('https://generativelanguage.googleapis.com/v1beta/openai');
    expect(row!.default_model).toBe('gemini-2.5-pro');
    expect(row!.timeout_ms).toBe(90000);
  });
});
// ===========================================================================
// 13. Public base URLs must remain accepted (SSRF hardening regressions)
// ===========================================================================

describe('Public base URL acceptance after SSRF hardening', () => {
  it.each([
    ['public 8.8.8.8', 'https://8.8.8.8/v1'],
    ['public 172.32.x (outside 172.16-31)', 'https://172.32.0.1/v1'],
    ['public 100.128.x (outside CGNAT)', 'https://100.128.0.1/v1'],
    ['public 11.0.0.1', 'https://11.0.0.1/v1'],
    ['normal domain', 'https://api.example.com/v1'],
    ['gemini openai-compat', 'https://generativelanguage.googleapis.com/v1beta/openai'],
  ])('accepts public base URL: %s', async (_label, url) => {
    const svc = makeService();
    await expect(svc.createProvider(adminId, { id: 'pub-prov', baseUrl: url, defaultModel: 'm' })).resolves.toBeUndefined();
  });
});

// ===========================================================================
// 14. Colon-bearing model ids (OpenRouter :free suffix)
// ===========================================================================

describe('Default models containing colons', () => {
  it('createProvider accepts and persists thinkingmachines/inkling:free', async () => {
    const svc = makeService();
    await svc.createProvider(adminId, {
      id: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: 'thinkingmachines/inkling:free',
    });
    const detail = await svc.inspectProvider(adminId, 'openrouter');
    expect(detail.defaultModel).toBe('thinkingmachines/inkling:free');
    const row = await env.DB.prepare('SELECT default_model FROM providers WHERE id = ?').bind('openrouter')
      .first<{ default_model: string }>();
    expect(row?.default_model).toBe('thinkingmachines/inkling:free');
  });

  it('updateProvider accepts a colon-bearing default model', async () => {
    const svc = makeService();
    await createValidProvider(svc, adminId);
    await svc.updateProvider(adminId, VALID_PROVIDER.id, { defaultModel: 'vendor/model:free' });
    const detail = await svc.inspectProvider(adminId, VALID_PROVIDER.id);
    expect(detail.defaultModel).toBe('vendor/model:free');
  });
});