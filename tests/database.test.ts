import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

it('applies the foundation migration exactly once', async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const rows = await env.DB.prepare('SELECT name FROM d1_migrations').all<{ name: string }>();
  expect(rows.results).toEqual([{ name: '0001_foundation.sql' }, { name: '0002_telegram.sql' }, { name: '0003_ai_providers.sql' }]);
});

it('creates no tables beyond the Phase 2 transport set', async () => {
  const rows = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
  expect(rows.results.map(({ name }) => name).filter((name) => !name.startsWith('sqlite_') && !name.startsWith('_cf_')).sort())
    .toEqual(['d1_migrations', 'processed_updates', 'provider_credentials', 'providers', 'users']);
});

it('keeps provider configuration free of secret columns', async () => {
  const columns = await env.DB.prepare('PRAGMA table_info(providers)').all<{ name: string }>();
  const names = columns.results.map(({ name }) => name);
  expect(names).toContain('base_url');
  expect(names.filter((name) => /secret|api[_-]?key|token|password/i.test(name))).toEqual([]);
  const credentialColumns = await env.DB.prepare('PRAGMA table_info(provider_credentials)').all<{ name: string }>();
  const credentialNames = credentialColumns.results.map(({ name }) => name);
  expect(credentialNames).toContain('secret_ciphertext');
  expect(credentialNames.filter((name) => name !== 'secret_ciphertext' && /secret|api[_-]?key|token|password/i.test(name))).toEqual([]);
});

it('enforces users uniqueness on the Telegram user ID', async () => {
  await env.DB.prepare(
    "INSERT INTO users (telegram_user_id, username, display_name, status, created_at, updated_at, last_seen) VALUES (?, ?, ?, 'active', ?, ?, ?)",
  ).bind(4242, 'dup', 'Dup', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z').run();
  await expect(
    env.DB.prepare(
      "INSERT INTO users (telegram_user_id, username, display_name, status, created_at, updated_at, last_seen) VALUES (?, ?, ?, 'active', ?, ?, ?)",
    ).bind(4242, 'dup', 'Dup', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z').run(),
  ).rejects.toThrow();
});

it('enforces processed_updates uniqueness on the Telegram update ID', async () => {
  await env.DB.prepare(
    'INSERT INTO processed_updates (update_id, telegram_user_id, kind, received_at) VALUES (?, ?, ?, ?)',
  ).bind(777, 4242, 'text', '2026-01-01T00:00:00.000Z').run();
  await expect(
    env.DB.prepare(
      'INSERT INTO processed_updates (update_id, telegram_user_id, kind, received_at) VALUES (?, ?, ?, ?)',
    ).bind(777, 4242, 'text', '2026-01-01T00:00:00.000Z').run(),
  ).rejects.toThrow();
});

it('runs prepared parameter binding against real local D1', async () => {
  const value = 'plain text with an apostrophe: \' and punctuation';
  const row = await env.DB.prepare('SELECT ? AS value').bind(value).first<{ value: string }>();
  expect(row).toEqual({ value });
});

it('allows isolated test writes', async () => {
  await env.DB.prepare('CREATE TABLE test_only (value TEXT NOT NULL)').run();
  await env.DB.prepare('INSERT INTO test_only (value) VALUES (?)').bind('isolated').run();
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM test_only').first('count')).toBe(1);
});

it('does not retain test writes between tests', async () => {
  expect(await env.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'test_only'").first()).toBeNull();
});
