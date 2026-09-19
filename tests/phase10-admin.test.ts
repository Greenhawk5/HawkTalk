import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { AdminService } from '../src/admin/service';
import { canPerform } from '../src/admin/types';

const NOW = '2026-09-18T00:00:00.000Z';

async function seedUser(telegramId: number, role: string, status = 'active'): Promise<number> {
  await env.DB.prepare(
    "INSERT INTO users (telegram_user_id, username, display_name, status, role, created_at, updated_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(telegramId, `u${telegramId}`, `User ${telegramId}`, status, role, NOW, NOW, NOW)
    .run();
  const row = await env.DB.prepare('SELECT id FROM users WHERE telegram_user_id = ?').bind(telegramId).first<{ id: number }>();
  return row?.id ?? 0;
}

let ownerId = 0;
let adminId = 0;
let userId = 0;

beforeEach(async () => {
  ownerId = await seedUser(73001, 'OWNER');
  adminId = await seedUser(73002, 'ADMIN');
  userId = await seedUser(73003, 'USER');
});

describe('Phase 10 admin analytics', () => {
  it('restricts usage visibility and price editing to OWNER', () => {
    expect(canPerform('OWNER', 'usage.view')).toBe(true);
    expect(canPerform('OWNER', 'prices.edit')).toBe(true);
    expect(canPerform('ADMIN', 'usage.view')).toBe(false);
    expect(canPerform('ADMIN', 'prices.edit')).toBe(false);
  });

  it('lets OWNER view the fleet summary but not ADMIN, USER, or strangers', async () => {
    const svc = new AdminService(env.DB, () => NOW);
    await expect(svc.getUsageSummary(ownerId)).resolves.toEqual({
      generations: 0, inputTokens: 0, outputTokens: 0, estimatedCostMicrodollars: 0,
    });
    await expect(svc.getUsageSummary(adminId)).rejects.toMatchObject({ kind: 'not_authorized' });
    await expect(svc.getUsageSummary(userId)).rejects.toMatchObject({ kind: 'not_authorized' });
    await expect(svc.getUsageSummary(424242)).rejects.toMatchObject({ kind: 'not_authorized' });
  });

  it('lets OWNER set model prices with validation and audit, nobody else', async () => {
    const svc = new AdminService(env.DB, () => NOW);
    await svc.setModelPrice(ownerId, 'acme', 'acme:model-x', 1_000_000, 2_000_000);
    const row = await env.DB.prepare('SELECT input_microdollars_per_mtok AS input_price FROM provider_prices WHERE provider_id = ? AND vendor_model = ?')
      .bind('acme', 'acme:model-x')
      .first<{ input_price: number }>();
    expect(row?.input_price).toBe(1_000_000);
    await expect(svc.setModelPrice(adminId, 'acme', 'acme:model-x', 1, 1)).rejects.toMatchObject({ kind: 'not_authorized' });
    await expect(svc.setModelPrice(ownerId, 'ACME!', 'm', 1, 1)).rejects.toMatchObject({ kind: 'validation_failed' });
    await expect(svc.setModelPrice(ownerId, 'acme', '', 1, 1)).rejects.toMatchObject({ kind: 'validation_failed' });
    await expect(svc.setModelPrice(ownerId, 'acme', 'm', -1, 1)).rejects.toMatchObject({ kind: 'validation_failed' });
    // Price edits are audited; unauthorized attempts are not recorded as edits.
    const audits = await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_audit_logs WHERE action = 'prices.edit'").first<{ n: number }>();
    expect(audits?.n).toBe(1);
  });

  it('exposes routing profiles to admins without secrets', async () => {
    const svc = new AdminService(env.DB, () => NOW);
    const profiles = await svc.getRoutingProfiles(adminId);
    expect(profiles.map((entry) => entry.profile)).toEqual(['FAST', 'DEFAULT', 'COMPLEX', 'RESEARCH']);
    expect(JSON.stringify(profiles)).not.toMatch(/sk-|token|secret|key/i);
    await expect(svc.getRoutingProfiles(userId)).rejects.toMatchObject({ kind: 'not_authorized' });
  });
});