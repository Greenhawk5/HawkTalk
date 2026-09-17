import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi, type Mock } from 'vitest';
import { OpenAICompatibleAdapter } from '../src/ai/adapter';
import { D1CredentialStore, resolveCredentialPlaintext, StaticCredentialStore, type StoredCredential } from '../src/ai/credentials';
import { sealCredential, unsealCredential } from '../src/ai/crypto';
import {
  AIRouter,
  D1ProviderDirectory,
  InMemoryRouterHealth,
  orderCredentials,
  StaticProviderDirectory,
  type ProviderDirectoryEntry,
} from '../src/ai/router';
import { runAgent } from '../src/agent/engine';
import { AgentError } from '../src/agent/errors';
import { ProviderError } from '../src/agent/errors';
import type { ProviderGenerateInput } from '../src/agent/provider';

type FetchMock = Mock<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;

const MASTER = 'test-master-secret-001';
const KEY_A = 'test-api-key-aaa-001';
const KEY_B = 'test-api-key-bbb-002';
const NOW = '2026-09-17T12:00:00.000Z';

let SEALED_A = '';
let SEALED_B = '';
beforeAll(async () => {
  SEALED_A = await sealCredential(KEY_A, MASTER);
  SEALED_B = await sealCredential(KEY_B, MASTER);
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function completion(text: string, usage?: { prompt_tokens: number; completion_tokens: number }, model = 'vendor-model'): Response {
  return jsonResponse({ id: 'x', object: 'chat.completion', model, choices: [{ message: { role: 'assistant', content: text } }], ...(usage ? { usage } : {}) });
}

function mockFetch(source: Response | ((url: string, init?: RequestInit) => Response | Promise<Response>)): FetchMock {
  const mock: FetchMock = vi.fn();
  if (typeof source === 'function') {
    mock.mockImplementation((input, init) => Promise.resolve(source(String(input), init)));
  } else {
    // Clone per call: Response bodies are single-use, like the real network.
    mock.mockImplementation(() => Promise.resolve(source.clone()));
  }
  return mock;
}

function callsOf(mock: FetchMock): Array<{ url: string; headers: Record<string, string>; json: Record<string, unknown> }> {
  return mock.mock.calls.map((call) => {
    const init = call[1];
    if (!init) throw new Error('expected request init');
    return { url: String(call[0]), headers: { ...(init.headers as Record<string, string>) }, json: JSON.parse(String(init.body)) as Record<string, unknown> };
  });
}

function hangingFetch(): FetchMock {
  const mock: FetchMock = vi.fn();
  mock.mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
    if (init?.signal?.aborted === true) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }));
  return mock;
}

function providerEntry(overrides: Partial<ProviderDirectoryEntry> = {}): ProviderDirectoryEntry {
  return { id: 'p1', baseUrl: 'https://ai-one.test', weight: 100, defaultModel: 'default-m', timeoutMs: 5000, maxCredentialAttempts: 3, ...overrides };
}

function storedCredential(overrides: Partial<StoredCredential> = {}): StoredCredential {
  return { id: 'key-1', providerId: 'p1', label: 'first', enabled: true, weight: 100, ciphertext: SEALED_A, ...overrides };
}

function agentInput(model: string): ProviderGenerateInput {
  return { requestId: 'req-1', model, systemPrompt: 'sys', messages: [{ role: 'user', content: 'hello' }], maxOutputTokens: 100 };
}

// --- adapter ---------------------------------------------------------------

describe('OpenAI-compatible adapter', () => {
  it('sends a well-formed request with bearer auth', async () => {
    const fetchMock = mockFetch(completion('hi', { prompt_tokens: 5, completion_tokens: 2 }, 'served-model'));
    const adapter = new OpenAICompatibleAdapter({ id: 'p1', baseUrl: 'https://ai-one.test/', apiKey: KEY_A, fetchImpl: fetchMock });
    const result = await adapter.generate(agentInput('vendor-m'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [call] = callsOf(fetchMock);
    expect(call?.url).toBe('https://ai-one.test/chat/completions');
    expect(call?.headers['authorization']).toBe(`Bearer ${KEY_A}`);
    expect(call?.json).toEqual({
      model: 'vendor-m',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }],
      max_tokens: 100,
    });
    expect(result).toEqual({ text: 'hi', model: 'served-model', usage: { inputTokens: 5, outputTokens: 2 } });
  });
  it('passes temperature only when set and omits empty system prompts', async () => {
    const fetchMock = mockFetch(completion('t'));
    const adapter = new OpenAICompatibleAdapter({ id: 'p1', baseUrl: 'https://ai-one.test', apiKey: KEY_A, fetchImpl: fetchMock });
    await adapter.generate({ ...agentInput('m'), systemPrompt: '', temperature: 0.5 });
    const [call] = callsOf(fetchMock);
    const messages = call?.json['messages'] as unknown[];
    expect(messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(call?.json['temperature']).toBe(0.5);
  });
  it('falls back to the request model when the response omits it', async () => {
    const fetchMock = mockFetch(jsonResponse({ choices: [{ message: { content: 'x' } }] }));
    const adapter = new OpenAICompatibleAdapter({ id: 'p1', baseUrl: 'https://ai-one.test', apiKey: KEY_A, fetchImpl: fetchMock });
    expect((await adapter.generate(agentInput('req-model'))).model).toBe('req-model');
  });
  it.each([
    ['non-JSON body', new Response('not json', { status: 200 })],
    ['empty body', new Response('', { status: 200 })],
    ['missing choices', jsonResponse({})],
    ['empty choices', jsonResponse({ choices: [] })],
    ['missing content', jsonResponse({ choices: [{ message: {} }] })],
    ['non-string content', jsonResponse({ choices: [{ message: { content: 42 } }] })],
    ['bad usage', jsonResponse({ choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: -1 } })],
  ])('maps %s to malformed without retry', async (_label, response) => {
    const fetchMock = mockFetch(response);
    const adapter = new OpenAICompatibleAdapter({ id: 'p1', baseUrl: 'https://ai-one.test', apiKey: KEY_A, fetchImpl: fetchMock });
    try {
      await adapter.generate(agentInput('m'));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).code).toBe('malformed');
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([[400], [401], [403], [404], [429], [500], [503]])('maps HTTP %i with its status, single attempt', async (status) => {
    const fetchMock = mockFetch(new Response(`upstream-${status}`, { status }));
    const adapter = new OpenAICompatibleAdapter({ id: 'p1', baseUrl: 'https://ai-one.test', apiKey: KEY_A, fetchImpl: fetchMock });
    try {
      await adapter.generate(agentInput('m'));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).code).toBe('upstream');
      expect((error as ProviderError).httpStatus).toBe(status);
      expect(String(error)).not.toContain(`upstream-${status}`);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('maps network failure to upstream and timeout to timeout', async () => {
    const down: FetchMock = vi.fn();
    down.mockRejectedValue(new TypeError('fetch failed'));
    const adapter = new OpenAICompatibleAdapter({ id: 'p1', baseUrl: 'https://ai-one.test', apiKey: KEY_A, fetchImpl: down });
    await expect(adapter.generate(agentInput('m'))).rejects.toMatchObject({ name: 'ProviderError', httpStatus: undefined });
    try {
      await adapter.generate(agentInput('m'));
      expect.unreachable();
    } catch (error) {
      expect((error as ProviderError).code).toBe('upstream');
    }
    const slow = new OpenAICompatibleAdapter({ id: 'p1', baseUrl: 'https://ai-one.test', apiKey: KEY_A, fetchImpl: hangingFetch(), timeoutMs: 5 });
    await expect(slow.generate(agentInput('m'))).rejects.toMatchObject({ name: 'ProviderError' });
    try {
      await slow.generate(agentInput('m'));
      expect.unreachable();
    } catch (error) {
      expect((error as ProviderError).code).toBe('timeout');
    }
  });
  it('does not call fetch when already cancelled', async () => {
    const fetchMock = mockFetch(completion('x'));
    const adapter = new OpenAICompatibleAdapter({ id: 'p1', baseUrl: 'https://ai-one.test', apiKey: KEY_A, fetchImpl: fetchMock });
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.generate({ ...agentInput('m'), signal: controller.signal })).rejects.toMatchObject({ name: 'ProviderError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('validates constructor options', () => {
    expect(() => new OpenAICompatibleAdapter({ id: '', baseUrl: 'https://x', apiKey: 'k' })).toThrow();
    expect(() => new OpenAICompatibleAdapter({ id: 'p', baseUrl: '', apiKey: 'k' })).toThrow();
    expect(() => new OpenAICompatibleAdapter({ id: 'p', baseUrl: 'https://x', apiKey: '' })).toThrow();
    expect(() => new OpenAICompatibleAdapter({ id: 'p', baseUrl: 'https://x', apiKey: 'k', timeoutMs: 0 })).toThrow();
  });
  it('never embeds credentials in errors', async () => {
    const fetchMock = mockFetch(new Response('nope', { status: 500 }));
    const adapter = new OpenAICompatibleAdapter({ id: 'p1', baseUrl: 'https://ai-one.test', apiKey: KEY_A, fetchImpl: fetchMock });
    try {
      await adapter.generate(agentInput('m'));
      expect.unreachable();
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(KEY_A);
      expect((error as Error).message).not.toContain(KEY_A);
    }
  });
});

// --- crypto -----------------------------------------------------------------

describe('credential crypto', () => {
  it('round-trips seal and unseal', async () => {
    const sealed = await sealCredential('super-secret-key', MASTER);
    expect(await unsealCredential(sealed, MASTER)).toBe('super-secret-key');
  });
  it('rejects the wrong master secret generically', async () => {
    const sealed = await sealCredential(KEY_A, MASTER);
    await expect(unsealCredential(sealed, 'wrong-master')).rejects.toThrow('Credential decryption failed');
  });
  it('rejects tampered envelopes', async () => {
    const sealed = await sealCredential(KEY_A, MASTER);
    const parts = sealed.split('.');
    const tampered = [...parts.slice(0, 3), `${parts[3]?.slice(0, -2)}AA`].join('.');
    await expect(unsealCredential(tampered, MASTER)).rejects.toThrow('Credential decryption failed');
  });
  it.each([
    ['wrong part count', 'v1.abc'],
    ['wrong version', 'v2.abc.def.ghi'],
    ['bad base64', 'v1.!!!.def.ghi'],
    ['empty', ''],
  ])('rejects malformed envelope: %s', async (_label, sealed) => {
    await expect(unsealCredential(sealed, MASTER)).rejects.toThrow('Credential envelope is invalid');
  });
  it('uses a fresh IV and salt per seal', async () => {
    const first = await sealCredential(KEY_A, MASTER);
    const second = await sealCredential(KEY_A, MASTER);
    expect(first).not.toBe(second);
    expect(await unsealCredential(first, MASTER)).toBe(KEY_A);
    expect(await unsealCredential(second, MASTER)).toBe(KEY_A);
  });
  it('never embeds plaintext in the envelope', async () => {
    const plaintext = 'plaintext-marker-9z8q';
    const sealed = await sealCredential(plaintext, MASTER);
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain(plaintext);
    expect(sealed).not.toContain(MASTER);
  });
  it('fails closed on empty inputs', async () => {
    await expect(sealCredential('', MASTER)).rejects.toThrow();
    await expect(sealCredential(KEY_A, '')).rejects.toThrow('Credential master secret is not configured');
    await expect(unsealCredential(SEALED_A, '')).rejects.toThrow('Credential master secret is not configured');
  });
});

// --- credential store --------------------------------------------------------

describe('credential store', () => {
  async function seedProvider(db: D1Database, id = 'p1'): Promise<void> {
    await db.prepare(
      "INSERT INTO providers (id, base_url, enabled, weight, default_model, timeout_ms, max_credential_attempts, created_at, updated_at) VALUES (?, ?, 1, 100, 'dm', 5000, 3, ?, ?)",
    ).bind(id, `https://${id}.test`, NOW, NOW).run();
  }

  it('lists sealed credentials without ever exposing plaintext', async () => {
    await seedProvider(env.DB);
    await env.DB.prepare(
      "INSERT INTO provider_credentials (id, provider_id, label, enabled, weight, secret_ciphertext, created_at, updated_at) VALUES (?, 'p1', ?, 1, 100, ?, ?, ?)",
    ).bind('k1', 'first', SEALED_A, NOW, NOW).run();
    const store = new D1CredentialStore(env.DB);
    const rows = await store.listCredentials('p1');
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(KEY_A);
    expect(rows[0]).toMatchObject({ id: 'k1', providerId: 'p1', label: 'first', enabled: true, weight: 100 });
    expect(await resolveCredentialPlaintext(rows[0]?.ciphertext ?? '', MASTER)).toBe(KEY_A);
  });
  it('isolates credentials by provider', async () => {
    await seedProvider(env.DB, 'p1');
    await seedProvider(env.DB, 'p2');
    await env.DB.prepare(
      "INSERT INTO provider_credentials (id, provider_id, label, enabled, weight, secret_ciphertext, created_at, updated_at) VALUES ('k1', 'p1', 'a', 1, 100, ?, ?, ?)",
    ).bind(SEALED_A, NOW, NOW).run();
    await env.DB.prepare(
      "INSERT INTO provider_credentials (id, provider_id, label, enabled, weight, secret_ciphertext, created_at, updated_at) VALUES ('k2', 'p2', 'b', 1, 100, ?, ?, ?)",
    ).bind(SEALED_B, NOW, NOW).run();
    const store = new D1CredentialStore(env.DB);
    expect((await store.listCredentials('p1')).map((row) => row.id)).toEqual(['k1']);
    expect((await store.listCredentials('p2')).map((row) => row.id)).toEqual(['k2']);
    expect(await store.listCredentials('nope')).toEqual([]);
  });
  it('never persists plaintext in D1', async () => {
    await seedProvider(env.DB);
    await env.DB.prepare(
      "INSERT INTO provider_credentials (id, provider_id, label, enabled, weight, secret_ciphertext, created_at, updated_at) VALUES ('k1', 'p1', 'a', 1, 100, ?, ?, ?)",
    ).bind(SEALED_A, NOW, NOW).run();
    const rows = await env.DB.prepare('SELECT secret_ciphertext AS c FROM provider_credentials').all<{ c: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.c).toMatch(/^v1\./);
    expect(rows.results[0]?.c).not.toContain(KEY_A);
  });
  it('static store filters by provider for tests', async () => {
    const store = new StaticCredentialStore([storedCredential(), storedCredential({ id: 'k2', providerId: 'p2', ciphertext: SEALED_B })]);
    expect((await store.listCredentials('p1')).map((row) => row.id)).toEqual(['key-1']);
  });
});

// --- key ordering ------------------------------------------------------------

describe('credential ordering', () => {
  it('prefers enabled, healthy, high-weight credentials deterministically', () => {
    const health = new InMemoryRouterHealth(() => 1000);
    health.cooldown('cooled', 2000);
    const ordered = orderCredentials(
      [
        storedCredential({ id: 'b', weight: 100 }),
        storedCredential({ id: 'a', weight: 100 }),
        storedCredential({ id: 'heavy', weight: 200 }),
        storedCredential({ id: 'off', enabled: false, weight: 999 }),
        storedCredential({ id: 'cooled', weight: 999 }),
      ],
      health,
      1000,
    );
    expect(ordered.map((row) => row.id)).toEqual(['heavy', 'a', 'b']);
  });
  it('releases cooldowns after expiry', () => {
    let now = 1000;
    const health = new InMemoryRouterHealth(() => now);
    health.cooldown('k', 2000);
    expect(health.cooledUntil('k')).toBe(2000);
    now = 2001;
    expect(health.cooledUntil('k')).toBeUndefined();
  });
});

// --- router -------------------------------------------------------------------

describe('AI router', () => {
  let now = 1_000_000;
  const nowMs = (): number => now;

  function makeRouter(opts: {
    providers?: ProviderDirectoryEntry[];
    credentials?: StoredCredential[];
    fetchMock?: FetchMock;
    maxAttempts?: number;
    cooldowns?: { rateLimitedMs?: number; serverErrorMs?: number; invalidCredentialMs?: number };
  } = {}): { router: AIRouter; health: InMemoryRouterHealth; fetchMock: FetchMock } {
    const health = new InMemoryRouterHealth(nowMs);
    const fetchMock = opts.fetchMock ?? mockFetch(completion('routed!'));
    const router = new AIRouter({
      directory: new StaticProviderDirectory(opts.providers ?? [providerEntry()]),
      credentialStore: new StaticCredentialStore(opts.credentials ?? [storedCredential()]),
      health,
      masterSecret: MASTER,
      fetchImpl: fetchMock,
      nowMs,
      cooldowns: opts.cooldowns,
      maxAttempts: opts.maxAttempts,
    });
    return { router, health, fetchMock };
  }

  it('routes an explicit provider and passes the vendor model through', async () => {
    const { router, fetchMock } = makeRouter({
      providers: [providerEntry({ id: 'p1', weight: 1 }), providerEntry({ id: 'p2', baseUrl: 'https://ai-two.test', weight: 999 })],
    });
    const result = await router.generate(agentInput('p1:vendor-x'));
    expect(result.text).toBe('routed!');
    const [call] = callsOf(fetchMock);
    expect(call?.url).toBe('https://ai-one.test/chat/completions');
    expect(call?.json['model']).toBe('vendor-x');
  });
  it('uses the default provider for bare models and its default for empty parts', async () => {
    const { router, fetchMock } = makeRouter({
      providers: [providerEntry({ id: 'p1', weight: 1 }), providerEntry({ id: 'p2', baseUrl: 'https://ai-two.test', weight: 999, defaultModel: 'fallback-m' })],
      credentials: [
        storedCredential({ id: 'k1', providerId: 'p1', ciphertext: SEALED_A }),
        storedCredential({ id: 'k2', providerId: 'p2', ciphertext: SEALED_B }),
      ],
    });
    await router.generate(agentInput('bare-model'));
    expect(callsOf(fetchMock)[0]?.url).toBe('https://ai-two.test/chat/completions');
    await router.generate(agentInput('p1:'));
    const calls = callsOf(fetchMock);
    expect(calls[1]?.json['model']).toBe('default-m');
  });
  it('rejects unknown providers and leading-colon models without calling fetch', async () => {
    const { router, fetchMock } = makeRouter();
    await expect(router.generate(agentInput('ghost:m'))).rejects.toMatchObject({ name: 'ProviderError', code: 'unavailable' });
    await expect(router.generate(agentInput(':m'))).rejects.toMatchObject({ name: 'ProviderError', code: 'malformed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('fails over across credentials on 500 and cools the failed key', async () => {
    const fetchMock = mockFetch((_url, init) => {
      const auth = (init?.headers as Record<string, string>)['authorization'];
      return auth === `Bearer ${KEY_A}` ? new Response('boom', { status: 500 }) : completion('second-key-wins');
    });
    const { router, health } = makeRouter({
      fetchMock,
      credentials: [storedCredential({ id: 'ka', ciphertext: SEALED_A }), storedCredential({ id: 'kb', ciphertext: SEALED_B })],
    });
    const result = await router.generate(agentInput('p1:m'));
    expect(result.text).toBe('second-key-wins');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(health.cooledUntil('ka')).toBeGreaterThan(now);
    expect(health.cooledUntil('kb')).toBeUndefined();
  });
  it('cools 429 keys for the rate-limit duration', async () => {
    now = 1_000_000;
    const fetchMock = mockFetch((_url, init) => {
      const auth = (init?.headers as Record<string, string>)['authorization'];
      return auth === `Bearer ${KEY_A}` ? new Response('slow down', { status: 429 }) : completion('ok');
    });
    const { router, health } = makeRouter({
      fetchMock,
      cooldowns: { rateLimitedMs: 60_000, serverErrorMs: 1_000 },
      credentials: [storedCredential({ id: 'ka', ciphertext: SEALED_A }), storedCredential({ id: 'kb', ciphertext: SEALED_B })],
    });
    await router.generate(agentInput('p1:m'));
    expect(health.cooledUntil('ka')).toBe(now + 60_000);
    now += 2_000;
    const again = await router.generate(agentInput('p1:m'));
    expect(again.text).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('marks 401 keys invalid and avoids them on later calls', async () => {
    const fetchMock = mockFetch((_url, init) => {
      const auth = (init?.headers as Record<string, string>)['authorization'];
      return auth === `Bearer ${KEY_A}` ? new Response('bad key', { status: 401 }) : completion('good-key');
    });
    const { router } = makeRouter({
      fetchMock,
      cooldowns: { invalidCredentialMs: 3_600_000 },
      credentials: [storedCredential({ id: 'ka', ciphertext: SEALED_A }), storedCredential({ id: 'kb', ciphertext: SEALED_B })],
    });
    expect((await router.generate(agentInput('p1:m'))).text).toBe('good-key');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockClear();
    expect((await router.generate(agentInput('p1:m'))).text).toBe('good-key');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('does not fail over on 400 or malformed provider results', async () => {
    const bad = mockFetch(new Response('bad request', { status: 400 }));
    const { router } = makeRouter({
      fetchMock: bad,
      credentials: [storedCredential({ id: 'ka', ciphertext: SEALED_A }), storedCredential({ id: 'kb', ciphertext: SEALED_B })],
    });
    await expect(router.generate(agentInput('p1:m'))).rejects.toMatchObject({ name: 'ProviderError', code: 'upstream' });
    expect(bad).toHaveBeenCalledTimes(1);

    const weird = mockFetch(completion(''));
    const second = makeRouter({
      fetchMock: weird,
      credentials: [storedCredential({ id: 'ka', ciphertext: SEALED_A }), storedCredential({ id: 'kb', ciphertext: SEALED_B })],
    });
    await expect(second.router.generate(agentInput('p1:m'))).rejects.toMatchObject({ name: 'ProviderError', code: 'malformed' });
    expect(weird).toHaveBeenCalledTimes(1);
  });
  it('fails over across providers for bare models, but never for explicit ones', async () => {
    const fetchMock = mockFetch((url) => (String(url).includes('ai-one') ? new Response('down', { status: 500 }) : completion('p2-saves')));
    const providers = [providerEntry({ id: 'p1', weight: 200 }), providerEntry({ id: 'p2', baseUrl: 'https://ai-two.test', weight: 100 })];
    const credentials = [
      storedCredential({ id: 'k1', providerId: 'p1', ciphertext: SEALED_A }),
      storedCredential({ id: 'k2', providerId: 'p2', ciphertext: SEALED_B }),
    ];
    const first = makeRouter({ fetchMock, providers, credentials });
    expect((await first.router.generate(agentInput('bare'))).text).toBe('p2-saves');

    fetchMock.mockClear();
    const second = makeRouter({ fetchMock, providers, credentials });
    await expect(second.router.generate(agentInput('p1:only'))).rejects.toMatchObject({ name: 'ProviderError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('ai-one');
  });
  it('skips disabled credentials and reports unavailable when none qualify', async () => {
    const fetchMock = mockFetch(completion('x'));
    const { router } = makeRouter({ fetchMock, credentials: [storedCredential({ enabled: false })] });
    await expect(router.generate(agentInput('p1:m'))).rejects.toMatchObject({ name: 'ProviderError', code: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('caps total attempts and surfaces the last error', async () => {
    const fetchMock = mockFetch(new Response('down', { status: 500 }));
    const { router } = makeRouter({
      fetchMock,
      maxAttempts: 2,
      credentials: [
        storedCredential({ id: 'k1', ciphertext: SEALED_A }),
        storedCredential({ id: 'k2', ciphertext: SEALED_B }),
        storedCredential({ id: 'k3', ciphertext: SEALED_A }),
      ],
    });
    try {
      await router.generate(agentInput('p1:m'));
      expect.unreachable();
    } catch (error) {
      expect((error as ProviderError).code).toBe('upstream');
      expect((error as ProviderError).httpStatus).toBe(500);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('respects caller cancellation without further attempts', async () => {
    const fetchMock = mockFetch(new Response('down', { status: 500 }));
    const { router } = makeRouter({
      fetchMock,
      credentials: [storedCredential({ id: 'k1', ciphertext: SEALED_A }), storedCredential({ id: 'k2', ciphertext: SEALED_B })],
    });
    const controller = new AbortController();
    const pending = router.generate({ ...agentInput('p1:m'), signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'ProviderError' });
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(1);
  });
  it('skips undecryptable credentials and fails closed without a master secret', async () => {
    const fetchMock = mockFetch(completion('recovered'));
    const { router } = makeRouter({
      fetchMock,
      credentials: [storedCredential({ id: 'bad', ciphertext: 'v1.bogus.envelope.here' }), storedCredential({ id: 'good', ciphertext: SEALED_B })],
    });
    expect((await router.generate(agentInput('p1:m'))).text).toBe('recovered');
    expect(() =>
      new AIRouter({
        directory: new StaticProviderDirectory([providerEntry()]),
        credentialStore: new StaticCredentialStore([]),
        health: new InMemoryRouterHealth(nowMs),
        masterSecret: '',
      }),
    ).toThrow('Credential master secret is not configured');
  });
  it('never leaks credentials through router errors', async () => {
    const fetchMock = mockFetch(new Response('down', { status: 500 }));
    const { router } = makeRouter({ fetchMock });
    try {
      await router.generate(agentInput('p1:m'));
      expect.unreachable();
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(KEY_A);
      expect((error as Error).message).not.toContain(KEY_A);
    }
  });
});

// --- core integration ----------------------------------------------------------

const integrationNow = (): number => 1_000_000;

describe('agent core integration', () => {
  it('runs AgentRequest → router → adapter → AgentResponse with fakes only', async () => {
    const fetchMock = mockFetch(completion('integrated!', { prompt_tokens: 7, completion_tokens: 4 }));
    const router = new AIRouter({
      directory: new StaticProviderDirectory([providerEntry()]),
      credentialStore: new StaticCredentialStore([storedCredential()]),
      health: new InMemoryRouterHealth(integrationNow),
      masterSecret: MASTER,
      fetchImpl: fetchMock,
      nowMs: integrationNow,
    });
    const response = await runAgent(
      { requestId: 'req-9', userId: 'u-9', messages: [{ role: 'user', content: 'hi' }], config: { systemPrompt: 'sys', model: 'p1:chat' } },
      router,
    );
    expect(response).toEqual({ requestId: 'req-9', text: 'integrated!', model: 'vendor-model', usage: { inputTokens: 7, outputTokens: 4 } });
  });
  it('runs end-to-end on D1-backed directory and store', async () => {
    await env.DB.prepare(
      "INSERT INTO providers (id, base_url, enabled, weight, default_model, timeout_ms, max_credential_attempts, created_at, updated_at) VALUES ('dbp', 'https://db-ai.test', 1, 100, 'dm', 5000, 3, ?, ?)",
    ).bind(NOW, NOW).run();
    await env.DB.prepare(
      "INSERT INTO provider_credentials (id, provider_id, label, enabled, weight, secret_ciphertext, created_at, updated_at) VALUES ('dbk', 'dbp', 'seed', 1, 100, ?, ?, ?)",
    ).bind(SEALED_A, NOW, NOW).run();
    const fetchMock = mockFetch(completion('from-d1'));
    const router = new AIRouter({
      directory: new D1ProviderDirectory(env.DB),
      credentialStore: new D1CredentialStore(env.DB),
      health: new InMemoryRouterHealth(integrationNow),
      masterSecret: MASTER,
      fetchImpl: fetchMock,
      nowMs: integrationNow,
    });
    const response = await runAgent(
      { requestId: 'req-d', userId: 'u-d', messages: [{ role: 'user', content: 'hi' }], config: { systemPrompt: '', model: 'dbp:chat' } },
      router,
    );
    expect(response.text).toBe('from-d1');
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://db-ai.test/chat/completions');
  });
  it('maps an exhausted router to a generic core error', async () => {
    const fetchMock = mockFetch(new Response('slow', { status: 429 }));
    const router = new AIRouter({
      directory: new StaticProviderDirectory([providerEntry()]),
      credentialStore: new StaticCredentialStore([storedCredential()]),
      health: new InMemoryRouterHealth(integrationNow),
      masterSecret: MASTER,
      fetchImpl: fetchMock,
      nowMs: integrationNow,
    });
    try {
      await runAgent(
        { requestId: 'r', userId: 'u', messages: [{ role: 'user', content: 'hi' }], config: { systemPrompt: '', model: 'p1:m' } },
        router,
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AgentError);
      expect((error as AgentError).code).toBe('provider_failure');
      expect((error as AgentError).message).toBe('Model provider failed');
    }
  });
});
