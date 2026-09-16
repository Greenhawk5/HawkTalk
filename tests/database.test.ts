import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

it('applies the foundation migration exactly once', async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const rows = await env.DB.prepare('SELECT name FROM d1_migrations').all<{ name: string }>();
  expect(rows.results).toEqual([{ name: '0001_foundation.sql' }]);
});

it('creates no product tables', async () => {
  const rows = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
  expect(rows.results.map(({ name }) => name).filter((name) => !name.startsWith('sqlite_') && !name.startsWith('_cf_')))
    .toEqual(['d1_migrations']);
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
