import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  appendAuditLog,
  countAuditRecords,
  listAuditPage,
  MAX_AUDIT_ACTION_CHARS,
} from '../src/db/admin-audit';
import {
  countOwners,
  countUsers,
  countUsersByRole,
  findUserById,
  listUsersPage,
  updateUserRole,
  updateUserStatus,
} from '../src/db/admin-users';
import {
  countCredentials,
  countProviders,
  deleteCredential,
  findProviderById,
  listAllProviders,
  listCredentialMetaForProvider,
  setCredentialEnabled,
  setProviderEnabled,
} from '../src/db/admin-providers';
import { findPolicy, listPolicies, updatePolicy } from '../src/db/admin-policies';

const NOW = '2026-09-17T12:00:00.000Z';

async function seedUser(id: number, role = 'USER', status = 'active'): Promise<number> {
  await env.DB.prepare(
    "INSERT INTO users (telegram_user_id, username, display_name, status, role, created_at, updated_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(9000 + id, `u${id}`, `User ${id}`, status, role, NOW, NOW, NOW)
    .run();
  const row = await env.DB.prepare('SELECT id FROM users WHERE telegram_user_id = ?').bind(9000 + id).first<{ id: number }>();
  return row?.id ?? 0;
}

describe('admin audit log', () => {
  it('appends records with bounded fields and counts them', async () => {
    await appendAuditLog(env.DB, { actorUserId: 1, actorRole: 'ADMIN', action: 'x'.repeat(999), targetType: 'user', targetId: '42', success: true, detail: '{}', createdAt: NOW });
    const row = await env.DB.prepare('SELECT action FROM admin_audit_logs').first<{ action: string }>();
    expect(row?.action.length).toBe(MAX_AUDIT_ACTION_CHARS);
    expect(await countAuditRecords(env.DB)).toBe(1);
  });

  it('pages newest-first with a cursor and never exposes mutation', async () => {
    for (let i = 1; i <= 5; i += 1) {
      await appendAuditLog(env.DB, { actorUserId: 1, actorRole: 'OWNER', action: `action.${i}`, targetType: 'user', targetId: String(i), success: true, detail: '{}', createdAt: NOW });
    }
    const first = await listAuditPage(env.DB, null, 3);
    expect(first.records.map((r) => r.action)).toEqual(['action.5', 'action.4', 'action.3']);
    expect(first.nextCursor).toBe(first.records.at(-1)?.id ?? null);
    const second = await listAuditPage(env.DB, first.nextCursor, 3);
    expect(second.records.map((r) => r.action)).toEqual(['action.2', 'action.1']);
    expect(second.nextCursor).toBeNull();
  });
});

describe('admin users repository', () => {
  it('counts users by role and lists pages with keyset cursors', async () => {
    for (let i = 1; i <= 7; i += 1) await seedUser(i, i === 1 ? 'OWNER' : 'USER');
    expect(await countUsers(env.DB)).toBe(7);
    const counts = await countUsersByRole(env.DB);
    expect(counts.OWNER).toBe(1);
    expect(counts.USER).toBe(6);
    const page1 = await listUsersPage(env.DB, null, 3);
    expect(page1.users).toHaveLength(3);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listUsersPage(env.DB, page1.nextCursor, 3);
    expect(page2.users).toHaveLength(3);
    const page3 = await listUsersPage(env.DB, page2.nextCursor, 3);
    expect(page3.users).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();
  });

  it('changes role with an optimistic guard and blocks self-targeting', async () => {
    const id = await seedUser(11, 'USER');
    expect(await updateUserRole(env.DB, id, 'USER', 'VIP')).toBe(true);
    expect(await updateUserRole(env.DB, id, 'USER', 'OWNER')).toBe(false);
    expect(await updateUserRole(env.DB, id, 'VIP', 'VIP')).toBe(false);
    expect((await findUserById(env.DB, id))?.role).toBe('VIP');
  });

  it('flips status only between active and blocked', async () => {
    const id = await seedUser(12, 'USER');
    expect(await updateUserStatus(env.DB, id, 'active', 'blocked')).toBe(true);
    expect(await updateUserStatus(env.DB, id, 'active', 'blocked')).toBe(false);
    expect(await updateUserStatus(env.DB, id, 'blocked', 'active')).toBe(true);
    expect(await updateUserStatus(env.DB, id, 'active', 'suspended' as 'active')).toBe(false);
  });

  it('counts active owners for the last-owner guard', async () => {
    const owner = await seedUser(13, 'OWNER');
    expect(await countOwners(env.DB)).toBe(1);
    await updateUserStatus(env.DB, owner, 'active', 'blocked');
    expect(await countOwners(env.DB)).toBe(0);
  });
});

describe('admin providers repository', () => {
  it('lists providers and credential metadata without ciphertext', async () => {
    await env.DB.prepare("INSERT INTO providers (id, base_url, enabled, weight, default_model, timeout_ms, max_credential_attempts, created_at, updated_at) VALUES ('p1', 'https://api.test', 1, 100, 'm1', 1000, 1, ?, ?)").bind(NOW, NOW).run();
    await env.DB.prepare("INSERT INTO provider_credentials (id, provider_id, label, enabled, weight, secret_ciphertext, created_at, updated_at) VALUES ('c1', 'p1', 'primary', 1, 100, 'v1.sealed', ?, ?)").bind(NOW, NOW).run();
    const providers = await listAllProviders(env.DB);
    expect(providers).toHaveLength(1);
    const metas = await listCredentialMetaForProvider(env.DB, 'p1');
    expect(metas[0]).toMatchObject({ id: 'c1', providerId: 'p1', label: 'primary', enabled: true });
    expect(JSON.stringify(metas)).not.toContain('v1.sealed');
    expect(await countProviders(env.DB)).toEqual({ total: 1, enabled: 1 });
    expect(await countCredentials(env.DB)).toBe(1);
    expect((await findProviderById(env.DB, 'p1'))?.default_model).toBe('m1');
    expect(await findProviderById(env.DB, 'nope')).toBeNull();
  });

  it('toggles provider and credential state and deletes credentials', async () => {
    await env.DB.prepare("INSERT INTO providers (id, base_url, enabled, weight, default_model, timeout_ms, max_credential_attempts, created_at, updated_at) VALUES ('p1', 'https://api.test', 1, 100, 'm', 1000, 1, ?, ?)").bind(NOW, NOW).run();
    await env.DB.prepare("INSERT INTO provider_credentials (id, provider_id, label, enabled, weight, secret_ciphertext, created_at, updated_at) VALUES ('c1', 'p1', 'k', 1, 100, 'v1.x', ?, ?)").bind(NOW, NOW).run();
    expect(await setProviderEnabled(env.DB, 'p1', false)).toBe(true);
    expect(await setProviderEnabled(env.DB, 'p1', false)).toBe(false);
    expect((await findProviderById(env.DB, 'p1'))?.enabled).toBe(0);
    expect(await setCredentialEnabled(env.DB, 'c1', false)).toBe(true);
    expect(await deleteCredential(env.DB, 'c1')).toBe(true);
    expect(await deleteCredential(env.DB, 'c1')).toBe(false);
    expect(await countCredentials(env.DB)).toBe(0);
  });
});

describe('admin policies repository', () => {
  it('reads policies in role order', async () => {
    const policies = await listPolicies(env.DB);
    expect(policies.map((p) => p.role)).toEqual(['OWNER', 'ADMIN', 'VIP', 'USER', 'BLOCKED']);
    expect((await findPolicy(env.DB, 'USER'))?.daily_messages).toBe(100);
  });

  it('applies bounded partial updates and rejects invalid ones', async () => {
    expect(await updatePolicy(env.DB, 'USER', { daily_messages: 250 })).toBe(true);
    expect((await findPolicy(env.DB, 'USER'))?.daily_messages).toBe(250);
    expect(await updatePolicy(env.DB, 'USER', { daily_messages: -1 })).toBe(false);
    expect(await updatePolicy(env.DB, 'USER', { per_second: 1.5 as number })).toBe(false);
    expect(await updatePolicy(env.DB, 'NOPE' as 'USER', { daily_messages: 5 })).toBe(false);
    expect(await updatePolicy(env.DB, 'USER', {})).toBe(false);
  });
});
