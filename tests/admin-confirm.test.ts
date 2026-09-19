import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { AdminService } from '../src/admin/service';
import { findUserById } from '../src/db/admin-users';

const NOW = '2026-09-17T12:00:00.000Z';
// Two hours after NOW: confirmations issued at NOW have expired (TTL 10 min).
const MUCH_LATER = '2026-09-17T14:00:00.000Z';

async function seedUser(telegramId: number, role: string, status = 'active'): Promise<number> {
  await env.DB.prepare(
    "INSERT INTO users (telegram_user_id, username, display_name, status, role, created_at, updated_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(telegramId, `u${telegramId}`, `User ${telegramId}`, status, role, NOW, NOW, NOW)
    .run();
  const row = await env.DB.prepare('SELECT id FROM users WHERE telegram_user_id = ?').bind(telegramId).first<{ id: number }>();
  return row?.id ?? 0;
}

async function seedProvider(id: string): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO providers (id, base_url, enabled, weight, default_model, timeout_ms, max_credential_attempts, created_at, updated_at) VALUES (?, 'https://provider.test', 1, 100, 'm1', 1000, 1, ?, ?)",
  )
    .bind(id, NOW, NOW)
    .run();
}

async function seedCredential(id: string, providerId: string): Promise<void> {
  await seedProvider(providerId);
  await env.DB.prepare(
    "INSERT INTO provider_credentials (id, provider_id, label, enabled, weight, secret_ciphertext, created_at, updated_at) VALUES (?, ?, 'label', 1, 100, 'v1.sealed.envelope', ?, ?)",
  )
    .bind(id, providerId, NOW, NOW)
    .run();
}

let ownerId = 0;
let adminId = 0;
let admin2Id = 0;
let userId = 0;
let adminTargetId = 0;

beforeEach(async () => {
  ownerId = await seedUser(1000, 'OWNER');
  adminId = await seedUser(2000, 'ADMIN');
  admin2Id = await seedUser(2100, 'ADMIN');
  userId = await seedUser(4000, 'USER');
  adminTargetId = await seedUser(2500, 'ADMIN');
});

describe('destructive confirmation (durable, single-use, fail-closed)', () => {
  it('requests, confirms, and executes a credential deletion with audit', async () => {
    await seedCredential('cred-1', 'alpha');
    const svc = new AdminService(env.DB, () => NOW);
    const pending = await svc.requestDestructiveConfirmation(ownerId, { action: 'credentials.delete', credentialId: 'cred-1' });
    expect(pending.confirmationId).toMatch(/^[a-f0-9]{32}$/);
    const outcome = await svc.executeConfirmed(ownerId, pending.confirmationId);
    expect(outcome).toMatchObject({ action: 'credentials.delete', targetType: 'credential', targetId: 'cred-1' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM provider_credentials').first('n')).toBe(0);
  });

  it('rejects a confirmation executed by the wrong actor', async () => {
    await seedCredential('cred-2', 'alpha');
    const svc = new AdminService(env.DB, () => NOW);
    const pending = await svc.requestDestructiveConfirmation(ownerId, { action: 'credentials.delete', credentialId: 'cred-2' });
    // Another admin cannot use someone else's confirmation; the attempt does
    // NOT burn it — the rightful owner can still execute it.
    await expect(svc.executeConfirmed(adminId, pending.confirmationId)).rejects.toMatchObject({ kind: 'not_authorized' });
    await expect(svc.executeConfirmed(ownerId, pending.confirmationId)).resolves.toMatchObject({ action: 'credentials.delete' });
  });

  it('rejects reused (duplicate) confirmations and repeated mutation', async () => {
    await seedCredential('cred-3', 'alpha');
    const svc = new AdminService(env.DB, () => NOW);
    const pending = await svc.requestDestructiveConfirmation(ownerId, { action: 'credentials.delete', credentialId: 'cred-3' });
    await expect(svc.executeConfirmed(ownerId, pending.confirmationId)).resolves.toBeDefined();
    await expect(svc.executeConfirmed(ownerId, pending.confirmationId)).rejects.toMatchObject({ kind: 'conflict' });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM provider_credentials WHERE id = 'cred-3'").first('n')).toBe(0);
  });

  it('rejects expired confirmations', async () => {
    await seedCredential('cred-4', 'alpha');
    const svc = new AdminService(env.DB, () => NOW);
    const pending = await svc.requestDestructiveConfirmation(ownerId, { action: 'credentials.delete', credentialId: 'cred-4' });
    // The same durable state read at a later service clock fails closed.
    const later = new AdminService(env.DB, () => MUCH_LATER);
    await expect(later.executeConfirmed(ownerId, pending.confirmationId)).rejects.toMatchObject({ kind: 'conflict' });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM provider_credentials WHERE id = 'cred-4'").first('n')).toBe(1);
  });

  it('fails closed for unknown or malformed confirmation ids', async () => {
    const svc = new AdminService(env.DB, () => NOW);
    await expect(svc.executeConfirmed(ownerId, 'a'.repeat(32))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(svc.executeConfirmed(ownerId, 'NOT-HEX')).rejects.toMatchObject({ kind: 'validation_failed' });
    await expect(svc.describeConfirmation(ownerId, 'b'.repeat(32))).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('requires fresh authorization at execution time (actor disabled after request)', async () => {
    const svc = new AdminService(env.DB, () => NOW);
    const pending = await svc.requestDestructiveConfirmation(ownerId, {
      action: 'users.set_role',
      userId: adminTargetId,
      expectedRole: 'ADMIN',
      nextRole: 'USER',
    });
    // The acting OWNER is blocked after the confirmation was issued; the
    // executor must re-check authorization and refuse.
    await env.DB.prepare("UPDATE users SET status = 'blocked' WHERE id = ?").bind(ownerId).run();
    await expect(svc.executeConfirmed(ownerId, pending.confirmationId)).rejects.toMatchObject({ kind: 'not_authorized' });
    expect((await findUserById(env.DB, adminTargetId))?.role).toBe('ADMIN');
  });

  it('binding: a confirmation authorizes only its exact action and target', async () => {
    await seedCredential('cred-5', 'alpha');
    await seedCredential('cred-6', 'alpha');
    const svc = new AdminService(env.DB, () => NOW);
    const pending = await svc.requestDestructiveConfirmation(ownerId, { action: 'credentials.delete', credentialId: 'cred-5' });
    // Execution reads the stored binding only; executeConfirmed takes no
    // target arguments, so the action cannot be redirected.
    await expect(svc.executeConfirmed(ownerId, pending.confirmationId)).resolves.toMatchObject({ targetId: 'cred-5' });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM provider_credentials WHERE id = 'cred-6'").first('n')).toBe(1);
  });

  it('blocks a privileged user only with confirmation; ordinary blocking needs none', async () => {
    const svc = new AdminService(env.DB, () => NOW);
    const pending = await svc.requestDestructiveConfirmation(ownerId, { action: 'users.set_status', userId: adminTargetId, nextStatus: 'blocked' });
    await expect(svc.executeConfirmed(ownerId, pending.confirmationId)).resolves.toMatchObject({ action: 'users.set_status' });
    expect((await findUserById(env.DB, adminTargetId))?.status).toBe('blocked');
    // Ordinary USER: direct mutation without confirmation remains valid.
    await svc.setUserStatus(adminId, userId, 'blocked');
    expect((await findUserById(env.DB, userId))?.status).toBe('blocked');
  });

  it('audits confirmed destructive mutations exactly once, without secrets', async () => {
    await seedCredential('cred-7', 'alpha');
    const svc = new AdminService(env.DB, () => NOW);
    const pending = await svc.requestDestructiveConfirmation(ownerId, { action: 'credentials.delete', credentialId: 'cred-7' });
    await svc.executeConfirmed(ownerId, pending.confirmationId);
    const page = await svc.listAudit(ownerId, null);
    const matching = page.records.filter((r) => r.action === 'credentials.delete' && r.targetId === 'cred-7' && r.success);
    expect(matching).toHaveLength(1);
    expect(JSON.stringify(page)).not.toContain('v1.');
    expect(JSON.stringify(page)).not.toContain('token');
  });

  it('denies confirmation requests that would not be authorized anyway', async () => {
    const svc = new AdminService(env.DB, () => NOW);
    await expect(svc.requestDestructiveConfirmation(adminId, { action: 'credentials.delete', credentialId: 'cred-x' })).rejects.toMatchObject({ kind: 'not_authorized' });
    await expect(svc.requestDestructiveConfirmation(ownerId, { action: 'users.set_role', userId: ownerId, expectedRole: 'OWNER', nextRole: 'ADMIN' })).rejects.toMatchObject({ kind: 'validation_failed' });
    await expect(svc.requestDestructiveConfirmation(ownerId, { action: 'users.set_status', userId: 424242, nextStatus: 'blocked' })).rejects.toMatchObject({ kind: 'not_found' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_confirmations').first('n')).toBe(0);
  });

  it('describes a pending confirmation only to its owner', async () => {
    await seedCredential('cred-8', 'alpha');
    const svc = new AdminService(env.DB, () => NOW);
    const pending = await svc.requestDestructiveConfirmation(ownerId, { action: 'credentials.delete', credentialId: 'cred-8' });
    await expect(svc.describeConfirmation(ownerId, pending.confirmationId)).resolves.toMatchObject({ action: 'credentials.delete' });
    await expect(svc.describeConfirmation(admin2Id, pending.confirmationId)).rejects.toMatchObject({ kind: 'not_authorized' });
  });

  it('keeps confirmation single-use under concurrent duplicate delivery', async () => {
    await seedCredential('cred-9', 'alpha');
    const svc = new AdminService(env.DB, () => NOW);
    const pending = await svc.requestDestructiveConfirmation(ownerId, { action: 'credentials.delete', credentialId: 'cred-9' });
    // Two concurrent executions race on the guarded UPDATE; exactly one wins.
    const results = await Promise.allSettled([
      svc.executeConfirmed(ownerId, pending.confirmationId),
      svc.executeConfirmed(ownerId, pending.confirmationId),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM provider_credentials WHERE id = 'cred-9'").first('n')).toBe(0);
  });

});
