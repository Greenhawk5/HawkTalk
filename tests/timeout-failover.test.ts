// Regression tests for the provider-timeout failover incident:
// Production showed agent_stage_failed(provider_timeout) with NO
// provider_attempt_failed and NO Z.AI attempt. Root cause: the Agent engine's
// outer 30s watchdog raced (and preempted) the adapter's per-provider timeout,
// so AIRouter never observed the retryable ProviderError('timeout') and never
// failed over. These tests pin the corrected timeout ownership:
// adapter owns per-provider timeouts → AIRouter fails over → the engine
// watchdog is an overall bound only.
import { beforeAll, describe, expect, it, vi, type Mock } from 'vitest';
import { sealCredential } from '../src/ai/crypto';
import { StaticCredentialStore, type StoredCredential } from '../src/ai/credentials';
import { AIRouter, InMemoryRouterHealth, StaticProviderDirectory, type ProviderDirectoryEntry } from '../src/ai/router';
import { DEFAULT_AGENT_TIMEOUT_MS, MAX_AGENT_TIMEOUT_MS, runAgent } from '../src/agent/engine';
import type { ProviderGenerateInput } from '../src/agent/provider';

const MASTER = 'test-master-secret-001';
const KEY_A = 'test-api-key-aaa-001';
const KEY_B = 'test-api-key-bbb-002';
const SEALED = new Map<string, string>();

beforeAll(async () => {
  SEALED.set('a', await sealCredential(KEY_A, MASTER));
  SEALED.set('b', await sealCredential(KEY_B, MASTER));
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function completion(text: string, model = 'vendor-model'): Response {
  return jsonResponse({ id: 'x', object: 'chat.completion', model, choices: [{ message: { role: 'assistant', content: text } }] });
}

type FetchMock = Mock<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;
type FetchBehavior = 'hang' | Response;

/**
 * Fetch mock whose Nth call uses the Nth behavior. 'hang' models a hung
 * upstream (like the incident): the promise never settles until the request
 * is aborted, then rejects with an AbortError — exactly like workerd fetch.
 */
function fetchSequence(behaviors: FetchBehavior[]): FetchMock {
  const mock: FetchMock = vi.fn();
  mock.mockImplementation((_input, init) => {
    const behavior = behaviors[Math.min(mock.mock.calls.length - 1, behaviors.length - 1)] as FetchBehavior;
    if (behavior === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted === true) {
          reject(new DOMException('aborted', 'AbortError'));
          return;
        }
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }
    return Promise.resolve(behavior.clone() as Response);
  });
  return mock;
}

function providerEntry(overrides: Partial<ProviderDirectoryEntry> = {}): ProviderDirectoryEntry {
  return { id: 'p1', baseUrl: 'https://ai-one.test', weight: 100, defaultModel: 'default-m', timeoutMs: 5000, maxCredentialAttempts: 3, ...overrides };
}

function storedCredential(id: string, providerId: string, sealed: string): StoredCredential {
  return { id, providerId, label: id, enabled: true, weight: 100, ciphertext: sealed };
}

function agentInput(model: string): ProviderGenerateInput {
  return { requestId: 'req-t', model, systemPrompt: '', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 128 };
}

interface RouterOptions {
  fetchMock: FetchMock;
  providers?: ProviderDirectoryEntry[];
  credentials?: StoredCredential[];
}

function makeRouter(options: RouterOptions): AIRouter {
  return new AIRouter({
    directory: new StaticProviderDirectory(options.providers ?? [providerEntry()]),
    credentialStore: new StaticCredentialStore(options.credentials ?? [storedCredential('k1', 'p1', SEALED.get('a') as string)]),
    health: new InMemoryRouterHealth(() => 1_000_000),
    masterSecret: MASTER,
    fetchImpl: options.fetchMock,
    nowMs: () => 1_000_000,
  });
}

/** Captures console.error diagnostic events (router/adapter emit JSON lines). */
function startCapture(): { lines: Array<Record<string, unknown>>; stop: () => void } {
  const lines: Array<Record<string, unknown>> = [];
  const original = console.error;
  console.error = (...args: unknown[]): void => {
    try {
      lines.push(JSON.parse(String(args[0])) as Record<string, unknown>);
    } catch {
      // non-JSON output ignored
    }
  };
  return { lines, stop: () => { console.error = original; } };
}

/** Production-shaped directory: OpenRouter first by weight, Z.AI second. */
const productionProviders = (): ProviderDirectoryEntry[] => [
  providerEntry({ id: 'openrouter', baseUrl: 'https://openrouter.test', weight: 100, defaultModel: 'nvidia/nemotron-3.5-lightning:free', timeoutMs: 30 }),
  providerEntry({ id: 'zai', baseUrl: 'https://zai.test', weight: 50, defaultModel: 'glm-4.7-Flash', timeoutMs: 5000 }),
];

const productionCredentials = (): StoredCredential[] => [
  storedCredential('k-or', 'openrouter', SEALED.get('a') as string),
  storedCredential('k-zai', 'zai', SEALED.get('b') as string),
];

describe('timeout-driven cross-provider failover', () => {
  it('OpenRouter provider timeout → Z.AI is attempted with its own defaultModel and the response is returned', async () => {
    const fetchMock = fetchSequence(['hang', completion('zai answer', 'glm-4.7-Flash')]);
    const router = makeRouter({ fetchMock, providers: productionProviders(), credentials: productionCredentials() });
    // Anchor-provider reference with an empty model part: per-provider defaults.
    const response = await router.generate(agentInput('openrouter:'));
    expect(response.text).toBe('zai answer');
    expect(response.model).toBe('glm-4.7-Flash');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('zai.test');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ model: 'glm-4.7-Flash' });
  });

  it('provider timeout emits provider_attempt_failed (network phase) and no router_exhausted on successful failover', async () => {
    const fetchMock = fetchSequence(['hang', completion('zai answer', 'glm-4.7-Flash')]);
    const router = makeRouter({ fetchMock, providers: productionProviders(), credentials: productionCredentials() });
    const capture = startCapture();
    try {
      await router.generate(agentInput('openrouter:'));
    } finally {
      capture.stop();
    }
    const attempts = capture.lines.filter((line) => line['event'] === 'provider_attempt_failed');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ provider_id: 'openrouter', code: 'timeout', failure_phase: 'network' });
    expect(capture.lines.some((line) => line['event'] === 'router_exhausted')).toBe(false);
  });

  it('router_exhausted fires only after ALL eligible providers are exhausted', async () => {
    const fetchMock = fetchSequence(['hang', 'hang']);
    // Short per-provider timeouts on BOTH providers so full exhaustion fits the test timeout.
    const providers = (): ProviderDirectoryEntry[] => [
      providerEntry({ id: 'openrouter', baseUrl: 'https://openrouter.test', weight: 100, defaultModel: 'nvidia/nemotron-3.5-lightning:free', timeoutMs: 30 }),
      providerEntry({ id: 'zai', baseUrl: 'https://zai.test', weight: 50, defaultModel: 'glm-4.7-Flash', timeoutMs: 30 }),
    ];
    const router = makeRouter({ fetchMock, providers: providers(), credentials: productionCredentials() });
    const capture = startCapture();
    try {
      await expect(router.generate(agentInput('openrouter:'))).rejects.toMatchObject({ name: 'ProviderError', code: 'timeout' });
    } finally {
      capture.stop();
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const exhausted = capture.lines.filter((line) => line['event'] === 'router_exhausted');
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]).toMatchObject({ code: 'timeout' });
    expect(capture.lines.filter((line) => line['event'] === 'provider_attempt_failed')).toHaveLength(2);
  });

  it('explicit provider:model remains single-provider (no failover on timeout)', async () => {
    const fetchMock = fetchSequence(['hang']);
    const router = makeRouter({ fetchMock, providers: productionProviders(), credentials: productionCredentials() });
    await expect(router.generate(agentInput('openrouter:exact-model'))).rejects.toMatchObject({ name: 'ProviderError', code: 'timeout' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('openrouter.test');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ model: 'exact-model' });
  });

  it('bare-model routing is unchanged: highest-weight provider first, bare model verbatim, cross-provider failover intact', async () => {
    const fetchMock = fetchSequence(['hang', completion('bare-ok')]);
    const router = makeRouter({ fetchMock, providers: productionProviders(), credentials: productionCredentials() });
    const response = await router.generate(agentInput('some-bare-model'));
    // Bare models keep ALL enabled providers as failover candidates and never
    // swap to per-provider default models — pre-existing behavior, unchanged.
    expect(response.text).toBe('bare-ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('openrouter.test');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ model: 'some-bare-model' });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('zai.test');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ model: 'some-bare-model' });
  });

  it('a real upstream HTTP 504 is distinguished from a local AbortController timeout and fails over', async () => {
    const fetchMock = fetchSequence([new Response('gateway timeout', { status: 504 }), completion('after-504', 'glm-4.7-Flash')]);
    const router = makeRouter({ fetchMock, providers: productionProviders(), credentials: productionCredentials() });
    const capture = startCapture();
    try {
      const response = await router.generate(agentInput('openrouter:'));
      expect(response.text).toBe('after-504');
    } finally {
      capture.stop();
    }
    const attempts = capture.lines.filter((line) => line['event'] === 'provider_attempt_failed');
    expect(attempts).toHaveLength(1);
    // Upstream HTTP timeout: code 'upstream' + http_status, NOT code 'timeout'.
    expect(attempts[0]).toMatchObject({ provider_id: 'openrouter', code: 'upstream', http_status: 504, failure_phase: 'http' });
  });

  it('caller cancellation still aborts without further attempts', async () => {
    const fetchMock = fetchSequence(['hang']);
    const router = makeRouter({ fetchMock, providers: productionProviders(), credentials: productionCredentials() });
    const controller = new AbortController();
    const pending = router.generate({ ...agentInput('openrouter:'), signal: controller.signal });
    // Let the fetch actually start before cancelling (mirrors a real client hang-up).
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'ProviderError', code: 'timeout' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('engine overall timeout budget', () => {
  const agentRequest = { requestId: 'req-e', userId: 'u-e', messages: [{ role: 'user', content: 'hi' }], config: { systemPrompt: '', model: 'm' } };

  it('production regression: engine budget longer than per-provider timeouts allows failover end-to-end', async () => {
    // This is the exact production scenario: OpenRouter hangs, Z.AI answers.
    // With the old 30s engine race the whole operation died as
    // AgentError('provider_timeout') before failover could happen.
    const fetchMock = fetchSequence(['hang', completion('zai answer', 'glm-4.7-Flash')]);
    const router = makeRouter({ fetchMock, providers: productionProviders(), credentials: productionCredentials() });
    const response = await runAgent(agentRequest, router, { timeoutMs: 5000 });
    expect(response.text).toBe('zai answer');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('overall budget still bounds an uncooperative provider (never settles, ignores abort)', async () => {
    const uncooperative = {
      id: 'hung',
      generate: (): Promise<{ text: string; model: string }> => new Promise(() => undefined),
    };
    await expect(runAgent(agentRequest, uncooperative, { timeoutMs: 20 })).rejects.toMatchObject({ name: 'AgentError', code: 'provider_timeout' });
  });

  it('default overall budget exceeds a single per-provider timeout and stays capped', () => {
    expect(DEFAULT_AGENT_TIMEOUT_MS).toBeGreaterThan(60_000);
    expect(DEFAULT_AGENT_TIMEOUT_MS).toBeLessThanOrEqual(MAX_AGENT_TIMEOUT_MS);
    expect(MAX_AGENT_TIMEOUT_MS).toBe(300_000);
  });

  it('runAgent rejects out-of-range overall budgets', async () => {
    for (const timeoutMs of [0, -5, 1.5, Number.NaN, MAX_AGENT_TIMEOUT_MS + 1]) {
      await expect(runAgent(agentRequest, { id: 'p', generate: () => Promise.resolve({ text: 't', model: 'm' }) }, { timeoutMs })).rejects.toMatchObject({ code: 'invalid_request' });
    }
  });
});

