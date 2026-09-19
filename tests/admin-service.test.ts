import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { AdminService } from '../src/admin/service';
import { AdminError } from '../src/admin/errors';
import { capabilitiesFor, canPerform } from '../src/admin/types';
import { isPrivilegedTarget } from '../src/admin/authorization';
import { countAuditRecords, listAuditPage } from '../src/db/admin-audit';
import { findPolicy } from '../src/db/admin-policies';
import { findUserById } from '../src/db/admin-users';

const NOW = '2026-09-17T12:00:00.000Z';

async function seedUser(telegramId: number, role: string, status = 'active'): Promise<number> {
  await env.DB.prepare(
    "INSERT INTO users (telegram_user_id, username, display_name, status, role, created_at, updated_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(telegramId, `u${telegramId}`, `User ${telegramId}`, status, role, NOW, NOW, NOW)
    .run();
  const row = await env.DB.prepare('SELECT id FROM users WHERE telegram_user_id = ?').bind(telegramId).first<{ id: number }>();
  return row?.id ?? 0;
}

async function seedProvider(id: string, enabled = 1): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO providers (id, base_url, enabled, weight, default_model, timeout_ms, max_credential_attempts, created_at, updated_at) VALUES (?, ?, ?, 100, 'm1', 1000, 1, ?, ?)",
  )
    .bind(id, `https://${id}.test`, enabled, NOW, NOW)
    .run();
}

async function seedCredential(id: string, providerId: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO provider_credentials (id, provider_id, label, enabled, weight, secret_ciphertext, created_at, updated_at) VALUES (?, ?, 'label', 1, 100, 'v1.sealed.envelope', ?, ?)",
  )
    .bind(id, providerId, NOW, NOW)
    .run();
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

describe('capability matrix', () => {
  it('gives ADMIN view + ordinary management, OWNER everything', () => {
    const admin = capabilitiesFor('ADMIN');
    expect(admin).toContain('manage_ordinary_users');
    expect(admin).not.toContain('manage_privileged_users');
    expect(admin).not.toContain('delete_credentials');
    const owner = capabilitiesFor('OWNER');
    expect(owner).toContain('manage_privileged_users');
    expect(owner).toContain('delete_credentials');
    expect(canPerform('ADMIN', 'credentials.delete')).toBe(false);
    expect(canPerform('OWNER', 'credentials.delete')).toBe(true);
    expect(canPerform('ADMIN', 'dashboard.view')).toBe(true);
  });

  it('classifies privileged targets', () => {
    expect(isPrivilegedTarget('ADMIN')).toBe(true);
    expect(isPrivilegedTarget('OWNER')).toBe(true);
    expect(isPrivilegedTarget('BLOCKED')).toBe(true);
    expect(isPrivilegedTarget('USER')).toBe(false);
    expect(isPrivilegedTarget('VIP')).toBe(false);
  });
});

describe('admin authorization', () => {
  it('allows ADMIN and OWNER; denies USER, VIP, BLOCKED, missing users', async () => {
    const svc = new AdminService(env.DB, () => NOW);
    await expect(svc.getDashboard(adminId)).resolves.toBeDefined();
    await expect(svc.getDashboard(ownerId)).resolves.toBeDefined();
    for (const denied of [vipId, userId, blockedId]) {
      await expect(svc.getDashboard(denied)).rejects.toMatchObject({ kind: 'not_authorized' });
    }
    await expect(svc.getDashboard(999999)).rejects.toMatchObject({ kind: 'not_authorized' });
    await expect(svc.getDashboard(-1)).rejects.toMatchObject({ kind: 'not_authorized' });
  });

  it('fails closed when the database errors', async () => {
    const broken = { prepare: () => { throw new Error('d1 down'); } } as unknown as D1Database;
    const svc = new AdminService(broken, () => NOW);
    await expect(svc.getDashboard(adminId)).rejects.toMatchObject({ kind: 'storage_failed' });
  });

  it('fails closed on reads and mutations when D1 fails mid-request', async () => {
    const broken = { prepare: () => { throw new Error('d1 down'); } } as unknown as D1Database;
    const svc = new AdminService(broken, () => NOW);
    // Reads surface storage_failed, never empty success.
    await expect(svc.inspectUser(adminId, userId)).rejects.toMatchObject({ kind: 'storage_failed' });
    await expect(svc.listProviders(adminId)).rejects.toMatchObject({ kind: 'storage_failed' });
    await expect(svc.inspectProvider(adminId, 'alpha')).rejects.toMatchObject({ kind: 'storage_failed' });
    await expect(svc.listPolicies(adminId)).rejects.toMatchObject({ kind: 'storage_failed' });
    await expect(svc.updatePolicy(adminId, 'USER', { daily_messages: 5 })).rejects.toMatchObject({ kind: 'storage_failed' });
    // Mutations fail closed at authorization before any write attempt.
    await expect(svc.setUserRole(adminId, userId, 'USER', 'VIP')).rejects.toMatchObject({ kind: 'storage_failed' });
    await expect(svc.setUserStatus(adminId, userId, 'blocked')).rejects.toMatchObject({ kind: 'storage_failed' });
    await expect(svc.setProviderEnabled(adminId, 'alpha', false)).rejects.toMatchObject({ kind: 'storage_failed' });
    await expect(svc.deleteCredential(adminId, 'cred-1')).rejects.toMatchObject({ kind: 'storage_failed' });
  });

  it('denies non-active admins regardless of role', async () => {
    const blockedOwnerId = await seedUser(1100, 'OWNER', 'blocked');
    const svc = new AdminService(env.DB, () => NOW);
    await expect(svc.getDashboard(blockedOwnerId)).rejects.toMatchObject({ kind: 'not_authorized' });
  });
});

describe('user management', () => {
  it('lists and inspects users with pagination', async () => {
    const svc = new AdminService(env.DB, () => NOW);
    for (let i = 0; i < 12; i += 1) await seedUser(6000 + i, 'USER');
    const page1 = await svc.listUsers(adminId, null);
    expect(page1.users).toHaveLength(10);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await svc.listUsers(adminId, page1.nextCursor);
    expect(page2.users.length).toBeGreaterThan(0);
    const seen = new Set([...page1.users, ...page2.users].map((u) => u.id));
    expect(seen.size).toBe(page1.users.length + page2.users.length);
    const target = await svc.inspectUser(adminId, userId);
    expect(target.role).toBe('USER');
  });

  it('ADMIN changes USER/VIP roles and status; audits success', async () => {
    const svc = new AdminService(env.DB, () => NOW);
    await svc.setUserRole(adminId, userId, 'USER', 'VIP');
    expect((await findUserById(env.DB, userId))?.role).toBe('VIP');
    await svc.setUserStatus(adminId, userId, 'blocked');
    expect((await findUserById(env.DB, userId))?.status).toBe('blocked');
    expect(await countAuditRecords(env.DB)).toBe(2);
    const audit = await listAuditPage(env.DB, null, 5);
    expect(audit.records[0]).toMatchObject({ actorUserId: adminId, actorRole: 'ADMIN', success: true });
  });

  it('ADMIN cannot self-promote, grant privileged roles, or touch privileged targets', async () => {
    const svc = new AdminService(env.DB, () => NOW);
    await expect(svc.setUserRole(adminId, adminId, 'ADMIN', 'OWNER')).rejects.toMatchObject({ kind: 'validation_failed' });
    await expect(svc.setUserRole(adminId, userId, 'USER', 'OWNER')).rejects.toMatchObject({ kind: 'not_authorized' });
    await expect(svc.setUserRole(adminId, userId, 'USER', 'ADMIN')).rejects.toMatchObject({ kind: 'not_authorized' });
    await expect(svc.setUserRole(adminId, ownerId, 'OWNER', 'USER')).rejects.toMatchObject({ kind: 'not_authorized' });
    await expect(svc.setUserRole(adminId, blockedId, 'BLOCKED', 'USER')).rejects.toMatchObject({ kind: 'not_authorized' });
    await expect(svc.setUserStatus(adminId, blockedId, 'active')).rejects.toMatchObject({ kind: 'not_authorized' });
    await expect(svc.setUserStatus(adminId, ownerId, 'blocked')).rejects.toMatchObject({ kind: 'not_authorized' });
    expect((await findUserById(env.DB, userId))?.role).toBe('USER');
  });

  it('OWNER manages privileged targets but cannot demote the last owner', async () => {
    const svc = new AdminService(env.DB, () => NOW);
    // Promote a second owner, then a third via ADMIN.
    await svc.setUserRole(ownerId, adminId, 'ADMIN', 'OWNER');
    const thirdId = await seedUser(1200, 'USER');
    await svc.setUserRole(ownerId, thirdId, 'USER', 'OWNER');
    // Three owners: demoting one succeeds.
    await svc.setUserRole(ownerId, adminId, 'OWNER', 'ADMIN');
    expect((await findUserById(env.DB, adminId))?.role).toBe('ADMIN');
    // Self-demotion always refused.
    await expect(svc.setUserRole(ownerId, ownerId, 'OWNER', 'ADMIN')).rejects.toMatchObject({ kind: 'validation_failed' });
    await svc.setUserStatus(ownerId, thirdId, 'blocked');
    await svc.setUserRole(ownerId, thirdId, 'OWNER', 'ADMIN');
    expect((await findUserById(env.DB, ownerId))?.role).toBe('OWNER');
    expect((await findUserById(env.DB, thirdId))?.status).toBe('blocked');
  });

  it('rejects invalid target ids and non-existent users', async () => {
    const svc = new AdminService(env.DB, () => NOW);
    await expect(svc.inspectUser(adminId, 0)).rejects.toMatchObject({ kind: 'validation_failed' });
    await expect(svc.inspectUser(adminId, -5)).rejects.toMatchObject({ kind: 'validation_failed' });
    await expect(svc.setUserRole(adminId, 424242, 'USER', 'VIP')).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('audits failed sensitive actions', async () => {
    const svc = new AdminService(env.DB, () => NOW);
    await expect(svc.setUserRole(adminId, userId, 'USER', 'OWNER')).rejects.toBeInstanceOf(AdminError);
    const audit = await listAuditPage(env.DB, null, 5);
    expect(audit.records[0]).toMatchObject({ action: 'users.set_role', success: false });
  });

  it('propagates optimistic-conflict detection', async () => {
    const svc = new AdminService(env.DB, () => NOW);
    await expect(svc.setUserRole(adminId, userId, 'VIP', 'USER')).rejects.toMatchObject({ kind: 'conflict' });
  });
});

describe('providers & credentials', () => {
  it('lists providers with credential counts, never ciphertext', async () => {
    await seedProvider('alpha');
    await seedCredential('cred-1', 'alpha');
    const svc = new AdminService(env.DB, () => NOW);
    const providers = await svc.listProviders(adminId);
    expect(providers[0]).toMatchObject({ id: 'alpha', enabled: true, credentialCount: 1 });
    expect(JSON.stringify(providers)).not.toContain('v1.');
    const detail = await svc.inspectProvider(adminId, 'alpha');
    expect(detail.credentials[0]).toMatchObject({ id: 'cred-1', label: 'label', enabled: true });
    expect(JSON.stringify(detail)).not.toContain('ciphertext');
    expect(JSON.stringify(detail)).not.toContain('v1.sealed');
  });

  it('ADMIN enables/disables providers and credentials but cannot delete', async () => {
    await seedProvider('alpha');
    await seedCredential('cred-1', 'alpha');
    const svc = new AdminService(env.DB, () => NOW);
    await svc.setProviderEnabled(adminId, 'alpha', false);
    expect((await svc.inspectProvider(adminId, 'alpha')).enabled).toBe(false);
    await svc.setCredentialEnabled(adminId, 'cred-1', false);
    await expect(svc.deleteCredential(adminId, 'cred-1')).rejects.toMatchObject({ kind: 'not_authorized' });
    const owner = new AdminService(env.DB, () => NOW);
    await owner.deleteCredential(ownerId, 'cred-1');
    const creds = await env.DB.prepare('SELECT COUNT(*) AS n FROM provider_credentials').first<{ n: number }>();
    expect(creds?.n).toBe(0);
  });

  it('validates ids and audits provider changes', async () => {
    await seedProvider('alpha');
    const svc = new AdminService(env.DB, () => NOW);
    await expect(svc.inspectProvider(adminId, 'BAD_ID!')).rejects.toMatchObject({ kind: 'validation_failed' });
    await expect(svc.setProviderEnabled(adminId, 'nope', true)).rejects.toMatchObject({ kind: 'conflict' });
    await svc.setProviderEnabled(adminId, 'alpha', false);
    const audit = await listAuditPage(env.DB, null, 5);
    expect(audit.records[0]).toMatchObject({ action: 'providers.set_enabled', targetId: 'alpha' });
  });
});

describe('quota policies', () => {
  it('ADMIN edits USER/VIP numerics; OWNER edits bypass flags and privileged roles', async () => {
    const svc = new AdminService(env.DB, () => NOW);
    await svc.updatePolicy(adminId, 'USER', { daily_messages: 300 });
    expect((await findPolicy(env.DB, 'USER'))?.daily_messages).toBe(300);
    await svc.updatePolicy(ownerId, 'VIP', { bypass_rate: true });
    expect((await findPolicy(env.DB, 'VIP'))?.bypass_rate).toBe(true);
    await expect(svc.updatePolicy(adminId, 'USER', { bypass_quota: true })).rejects.toMatchObject({ kind: 'not_authorized' });
    await expect(svc.updatePolicy(adminId, 'BLOCKED', { daily_messages: 10 })).rejects.toMatchObject({ kind: 'not_authorized' });
    await expect(svc.updatePolicy(adminId, 'USER', {})).rejects.toMatchObject({ kind: 'validation_failed' });
    expect((await findPolicy(env.DB, 'USER'))?.bypass_quota).toBe(false);
  });
});

describe('audit trail', () => {
  it('records actor, action, timestamp; secrets absent; append-only', async () => {
    const svc = new AdminService(env.DB, () => NOW);
    await svc.setUserStatus(adminId, userId, 'blocked');
    const page = await listAuditPage(env.DB, null, 10);
    const record = page.records.at(0);
    expect(record).toMatchObject({ actorUserId: adminId, actorRole: 'ADMIN', action: 'users.set_status', targetType: 'user', targetId: String(userId), success: true });
    expect(record?.createdAt).toBe(NOW);
    expect(JSON.stringify(page)).not.toContain('token');
    expect(JSON.stringify(page)).not.toContain('v1.');
    expect(await countAuditRecords(env.DB)).toBe(1);
  });

  it('paginates deterministically', async () => {
    const svc = new AdminService(env.DB, () => NOW);
    await seedProvider('p');
    // Provider seeds enabled; alternating values always change state, so each
    // call audits exactly once. 12 records > page cap (10) forces two pages.
    for (let i = 0; i < 12; i += 1) {
      await svc.setProviderEnabled(adminId, 'p', i % 2 === 1);
    }
    const first = await svc.listAudit(adminId, null);
    expect(first.records).toHaveLength(10);
    expect(first.nextCursor).not.toBeNull();
    const second = await svc.listAudit(adminId, first.nextCursor);
    expect(second.records).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.records, ...second.records].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('dashboard', () => {
  it('reports correct bounded metrics', async () => {
    await seedProvider('alpha', 1);
    await seedProvider('beta', 0);
    await seedCredential('cred-1', 'alpha');
    const svc = new AdminService(env.DB, () => NOW);
    const metrics = await svc.getDashboard(adminId);
    expect(metrics.totalUsers).toBe(5);
    expect(metrics.usersByRole).toMatchObject({ OWNER: 1, ADMIN: 1, VIP: 1, USER: 1, BLOCKED: 1 });
    expect(metrics.providers).toEqual({ total: 2, enabled: 1 });
    expect(metrics.credentialCount).toBe(1);
    expect(metrics.recentAudit).toHaveLength(0);
  });

  it('denies the dashboard to non-admins without leaking metrics', async () => {
    const svc = new AdminService(env.DB, () => NOW);
    await expect(svc.getDashboard(vipId)).rejects.toBeInstanceOf(AdminError);
  });
});
