import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  listUserUsageEvents,
  recordUsageEvent,
  setProviderPrice,
  summarizeAllUsage,
  summarizeUsageByProvider,
  summarizeUserUsage,
} from '../src/db/usage';

const NOW = '2026-09-18T00:00:00.000Z';

async function seedUser(telegramId: number): Promise<number> {
  await env.DB.prepare(
    "INSERT INTO users (telegram_user_id, username, display_name, status, role, created_at, updated_at, last_seen) VALUES (?, ?, ?, 'active', 'USER', ?, ?, ?)",
  )
    .bind(telegramId, `u${telegramId}`, `User ${telegramId}`, NOW, NOW, NOW)
    .run();
  const row = await env.DB.prepare('SELECT id FROM users WHERE telegram_user_id = ?').bind(telegramId).first<{ id: number }>();
  return row?.id ?? 0;
}

describe('usage analytics ledger', () => {
  it('enforces schema constraints and rejects secret-looking columns', async () => {
    const columns = await env.DB.prepare('PRAGMA table_info(usage_events)').all<{ name: string }>();
    const names = columns.results.map(({ name }) => name);
    for (const required of ['id', 'user_id', 'provider_id', 'vendor_model', 'request_id', 'input_tokens', 'output_tokens', 'estimated_cost_microdollars', 'created_at']) {
      expect(names).toContain(required);
    }
    expect(names.filter((name) => /secret|api[_-]?key|token|password|prompt|content|message/i.test(name) && name !== 'input_tokens' && name !== 'output_tokens')).toEqual([]);
  });

  it('records generations with server-computed estimates and idempotent ids', async () => {
    const userId = await seedUser(61001);
    await setProviderPrice(env.DB, 'acme', 'acme:model-x', 1_000_000, 2_000_000, NOW);
    const input = {
      id: 'usage-event-1', userId, providerId: 'acme', vendorModel: 'acme:model-x',
      requestId: 'req-1', inputTokens: 500, outputTokens: 250, createdAt: NOW,
    };
    expect(await recordUsageEvent(env.DB, input)).toBe(true);
    // Redelivery of the same event id is a no-op: no double counting.
    expect(await recordUsageEvent(env.DB, input)).toBe(false);
    const summary = await summarizeUserUsage(env.DB, userId);
    expect(summary).toEqual({ generations: 1, inputTokens: 500, outputTokens: 250, estimatedCostMicrodollars: 1000 });
  });

  it('records cost 0 when no price row exists, and aggregates per provider', async () => {
    const userId = await seedUser(61002);
    await recordUsageEvent(env.DB, {
      id: 'usage-event-2', userId, providerId: 'mystery', vendorModel: 'mystery:v9',
      requestId: 'req-2', inputTokens: 10, outputTokens: 5, createdAt: NOW,
    });
    const summary = await summarizeUserUsage(env.DB, userId);
    expect(summary.estimatedCostMicrodollars).toBe(0);
    const byProvider = await summarizeUsageByProvider(env.DB, userId);
    expect(byProvider).toEqual([{ providerId: 'mystery', generations: 1, inputTokens: 10, outputTokens: 5, estimatedCostMicrodollars: 0 }]);
  });

  it('isolates users: no cross-user reads in summaries or listings', async () => {
    const alice = await seedUser(61003);
    const bob = await seedUser(61004);
    await recordUsageEvent(env.DB, {
      id: 'usage-event-3', userId: alice, providerId: 'acme', vendorModel: 'acme:m',
      requestId: 'req-3', inputTokens: 7, outputTokens: 3, createdAt: NOW,
    });
    expect((await summarizeUserUsage(env.DB, bob)).generations).toBe(0);
    expect(await listUserUsageEvents(env.DB, bob, 10)).toEqual([]);
    expect((await listUserUsageEvents(env.DB, alice, 10)).map((row) => row.id)).toEqual(['usage-event-3']);
    expect((await summarizeAllUsage(env.DB)).generations).toBeGreaterThanOrEqual(1);
  });

  it('bounds listings and rejects invalid event ids', async () => {
    const userId = await seedUser(61005);
    for (let i = 0; i < 3; i += 1) {
      await recordUsageEvent(env.DB, {
        id: `usage-bound-${i}`, userId, providerId: 'acme', vendorModel: 'acme:m',
        requestId: `req-bound-${i}`, inputTokens: 1, outputTokens: 1, createdAt: NOW,
      });
    }
    expect(await listUserUsageEvents(env.DB, userId, 2)).toHaveLength(2);
    await expect(recordUsageEvent(env.DB, {
      id: '', userId, providerId: 'acme', vendorModel: 'acme:m',
      requestId: 'req-bad', inputTokens: 1, outputTokens: 1, createdAt: NOW,
    })).rejects.toThrow();
  });
});