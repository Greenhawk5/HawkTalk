import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { D1AdmissionGate } from '../src/db/admission-d1';
import { claimUpdate, upsertTelegramUser } from '../src/db/telegram';
import { findInternalUserIdByTelegramId } from '../src/db/users';

const instant = '2026-09-17T12:00:00.000Z';

async function user(telegramId = 123): Promise<number> {
  await upsertTelegramUser(env.DB, { telegramUserId: telegramId, username: null, displayName: null }, instant);
  return (await findInternalUserIdByTelegramId(env.DB, telegramId))!;
}

async function claim(id: number, telegramId = 123): Promise<void> {
  await claimUpdate(env.DB, id, telegramId, 'text', instant);
}

function gate(time = instant): D1AdmissionGate {
  return new D1AdmissionGate(env.DB, { now: () => time });
}

async function policy(daily = 2, second = 100, hour = 100): Promise<void> {
  await env.DB.prepare("UPDATE admission_policies SET daily_messages = ?, per_second = ?, per_hour = ? WHERE role = 'USER'").bind(daily, second, hour).run();
}

describe('durable admission', () => {
  it('defaults new users to USER and accepts the exact quota boundary', async () => {
    const id = await user();
    expect(await env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(id).first('role')).toBe('USER');
    await policy();
    for (const update of [1, 2, 3]) await claim(update);
    expect(await gate().admit(id, 1)).toBe('allowed');
    expect(await gate().admit(id, 2)).toBe('allowed');
    expect(await gate().admit(id, 3)).toBe('quota_exceeded');
    expect(await env.DB.prepare('SELECT SUM(quota_units) AS n FROM request_admissions').first('n')).toBe(2);
  });

  it('serializes concurrent requests at the quota boundary', async () => {
    const id = await user();
    await policy(3);
    await Promise.all(Array.from({ length: 12 }, (_, i) => claim(i)));
    const decisions = await Promise.all(Array.from({ length: 12 }, (_, i) => gate().admit(id, i)));
    expect(decisions.filter(x => x === 'allowed')).toHaveLength(3);
    expect(decisions.filter(x => x === 'quota_exceeded')).toHaveLength(9);
  });

  it('charges duplicate updates once even after claim deletion and recreation', async () => {
    const id = await user();
    await claim(1);
    await Promise.all(Array.from({ length: 8 }, () => gate().admit(id, 1)));
    await env.DB.prepare('DELETE FROM processed_updates WHERE update_id = 1').run();
    await claim(1);
    expect(await gate().admit(id, 1)).toBe('allowed');
    expect(await env.DB.prepare('SELECT SUM(quota_units) AS n FROM request_admissions').first('n')).toBe(1);
  });

  it('resets quota at UTC midnight and leaves old decisions immutable', async () => {
    const id = await user();
    await policy(1);
    for (const update of [1, 2, 3]) await claim(update);
    expect(await gate().admit(id, 1)).toBe('allowed');
    expect(await gate().admit(id, 2)).toBe('quota_exceeded');
    expect(await gate('2026-09-18T00:00:00.000Z').admit(id, 3)).toBe('allowed');
    expect(await gate('2026-09-18T00:00:00.000Z').admit(id, 2)).toBe('quota_exceeded');
  });

  it('enforces per-second and hourly limits separately and resets windows', async () => {
    const id = await user();
    await policy(100, 1, 2);
    for (const update of [1, 2, 3, 4, 5]) await claim(update);
    expect(await gate().admit(id, 1)).toBe('allowed');
    expect(await gate().admit(id, 2)).toBe('rate_limited');
    expect(await gate('2026-09-17T12:00:01Z').admit(id, 3)).toBe('allowed');
    expect(await gate('2026-09-17T12:00:02Z').admit(id, 4)).toBe('rate_limited');
    expect(await gate('2026-09-17T13:00:00Z').admit(id, 5)).toBe('allowed');
  });

  it('serializes concurrent rate checks', async () => {
    const id = await user();
    await policy(100, 2, 100);
    await Promise.all(Array.from({ length: 10 }, (_, i) => claim(i)));
    const decisions = await Promise.all(Array.from({ length: 10 }, (_, i) => gate().admit(id, i)));
    expect(decisions.filter(x => x === 'allowed')).toHaveLength(2);
    expect(decisions.filter(x => x === 'rate_limited')).toHaveLength(8);
  });

  it('isolates users and rejects foreign or missing claims', async () => {
    const a = await user();
    const b = await user(456);
    await policy(1);
    await claim(1);
    await claim(2, 456);
    expect(await gate().admit(b, 1)).toBe('unavailable');
    expect(await gate().admit(a, 999)).toBe('unavailable');
    expect(await gate().admit(a, 1)).toBe('allowed');
    expect(await gate().admit(b, 2)).toBe('allowed');
  });

  it.each(['BLOCKED', 'ADMIN', 'OWNER', 'VIP'])('uses trusted %s policy', async role => {
    const id = await user();
    await policy(0);
    await env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, id).run();
    await claim(1);
    expect(await gate().admit(id, 1)).toBe(role === 'BLOCKED' ? 'blocked' : 'allowed');
    await upsertTelegramUser(env.DB, { telegramUserId: 123, username: 'OWNER', displayName: 'ADMIN' }, instant);
    expect(await env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(id).first('role')).toBe(role);
  });

  it('blocks inactive users even with bypass enabled', async () => {
    const id = await user();
    await env.DB.prepare("UPDATE users SET role = 'OWNER', status = 'blocked' WHERE id = ?").bind(id).run();
    await claim(1);
    expect(await gate().admit(id, 1)).toBe('blocked');
  });

  it('keeps rate protection for admins while tracking bypassed quota usage', async () => {
    const id = await user();
    await env.DB.prepare("UPDATE users SET role = 'ADMIN' WHERE id = ?").bind(id).run();
    await env.DB.prepare("UPDATE admission_policies SET daily_messages = 0, per_second = 1 WHERE role = 'ADMIN'").run();
    await claim(1); await claim(2);
    expect(await gate().admit(id, 1)).toBe('allowed');
    expect(await gate().admit(id, 2)).toBe('rate_limited');
    expect(await env.DB.prepare('SELECT SUM(quota_units) AS n FROM request_admissions').first('n')).toBe(1);
  });
});
