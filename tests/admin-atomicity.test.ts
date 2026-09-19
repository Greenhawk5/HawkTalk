import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { AdminService } from '../src/admin/service';

it('rolls back a provider change when its audit insert fails', async () => {
  const now = '2026-09-17T12:00:00.000Z';
  await env.DB.prepare(`INSERT INTO users (telegram_user_id, role, status, created_at, updated_at, last_seen)
    VALUES (99001, 'ADMIN', 'active', ?, ?, ?)`).bind(now, now, now).run();
  const actor = await env.DB.prepare('SELECT id FROM users WHERE telegram_user_id = 99001').first<number>('id');
  expect(actor).not.toBeNull();
  await env.DB.prepare(`INSERT INTO providers (id, base_url, default_model, created_at, updated_at)
    VALUES ('atomic-test', 'https://provider.invalid', 'test', ?, ?)`).bind(now, now).run();
  await env.DB.prepare(`CREATE TRIGGER reject_admin_audit BEFORE INSERT ON admin_audit_logs
    BEGIN SELECT RAISE(ABORT, 'test audit unavailable'); END`).run();

  const service = new AdminService(env.DB, () => now);
  await expect(service.setProviderEnabled(actor!, 'atomic-test', false))
    .rejects.toMatchObject({ kind: 'storage_failed' });
  expect(await env.DB.prepare("SELECT enabled FROM providers WHERE id = 'atomic-test'").first('enabled')).toBe(1);
  expect(await env.DB.prepare('SELECT COUNT(*) FROM admin_audit_logs').first('COUNT(*)')).toBe(0);
});
