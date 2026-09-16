import { env, exports as workerExports } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src';
import { route } from '../src/router';
import { validateEnv } from '../src/env';

const url = 'https://hawktalk.test';

describe('router unit', () => {
  it('returns minimal health status', async () => {
    expect(await route(new Request(`${url}/healthz`)).json()).toEqual({ status: 'ok' });
  });
  it.each(['/healthz/', '/HEALTHZ', '/', '/admin', '/webhook'])('does not expose %s', (path) => {
    expect(route(new Request(url + path)).status).toBe(404);
  });
});

describe('Worker HTTP integration', () => {
  it('serves health through the runtime entrypoint', async () => {
    const response = await workerExports.default.fetch(`${url}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });
  it.each(['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'])('rejects %s on health', async (method) => {
    const response = await workerExports.default.fetch(`${url}/healthz`, { method });
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET, HEAD');
    expect(await response.json()).toEqual({ error: 'Method not allowed' });
  });
  it.each(['/healthz', '/missing'])('omits body on HEAD %s', async (path) => {
    const response = await workerExports.default.fetch(url + path, { method: 'HEAD' });
    expect(response.status).toBe(path === '/healthz' ? 200 : 404);
    expect(await response.text()).toBe('');
  });
  it('returns safe not-found body without reflecting input', async () => {
    const response = await workerExports.default.fetch(`${url}/unknown?secret=untrusted-input`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });
});

describe('foundation security', () => {
  it.each(['/healthz', '/missing'])('secures responses for %s', async (path) => {
    const response = await workerExports.default.fetch(url + path, { headers: { Origin: 'https://other.test' } });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
  });
  it('generates independent request IDs rather than trusting caller headers', async () => {
    const responses = await Promise.all(Array.from({ length: 5 }, () => workerExports.default.fetch(`${url}/healthz`, {
      headers: { 'X-Request-ID': 'untrusted-correlation' },
    })));
    const ids = responses.map((response) => response.headers.get('X-Request-ID'));
    expect(new Set(ids).size).toBe(5);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('fails closed on missing binding, without leaking request or error data', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = worker.fetch(new Request(`${url}/healthz?private=untrusted-input`), { APP_ENV: 'development' });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Something went wrong' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
      event: 'request_failed', request_id: response.headers.get('X-Request-ID'),
    }));
  });
  it('does not log raw exceptions from bindings', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = { APP_ENV: 'development' as const, get DB(): D1Database { throw new Error('sensitive-diagnostic'); } };
    const response = worker.fetch(new Request(`${url}/healthz`), broken);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('sensitive-diagnostic');
    expect(JSON.stringify(log.mock.calls)).not.toContain('sensitive-diagnostic');
  });
  it('rejects an absent environment name', () => {
    expect(() => validateEnv({ DB: env.DB })).toThrow('Invalid environment configuration');
  });
  it.each(['development', 'staging', 'production'] as const)('accepts %s with a binding', (APP_ENV) => {
    expect(() => validateEnv({ APP_ENV, DB: env.DB })).not.toThrow();
  });
});
