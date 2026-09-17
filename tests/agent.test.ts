import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProviderMessages, runAgent, validateAgentRequest } from '../src/agent/engine';
import { AgentError, isAgentResponse, ProviderError, toAgentError } from '../src/agent/errors';
import type { ModelProvider, ProviderGenerateInput, ProviderGenerateResult } from '../src/agent/provider';
import type { AgentRequest } from '../src/agent/types';
import {
  DEFAULT_OUTPUT_TOKENS,
  MAX_MESSAGES,
  MAX_MESSAGE_CHARS,
  MAX_METADATA_KEYS,
  MAX_MODEL_ID_CHARS,
  MAX_OUTPUT_TOKENS,
  MAX_PROVIDER_TEXT_CHARS,
  MAX_SYSTEM_PROMPT_CHARS,
  MAX_TOTAL_CONTENT_CHARS,
} from '../src/agent/types';

afterEach(() => {
  vi.unstubAllGlobals();
});

function validRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'req-1',
    userId: 'user-7',
    messages: [{ role: 'user', content: 'hello' }],
    config: { systemPrompt: 'You are HawkTalk.', model: 'test-model' },
    ...overrides,
  };
}

function fakeProvider(
  behavior: (input: ProviderGenerateInput) => Promise<ProviderGenerateResult>,
  id = 'fake',
): ModelProvider & { calls: ProviderGenerateInput[] } {
  const calls: ProviderGenerateInput[] = [];
  return {
    id,
    calls,
    generate: (input) => {
      calls.push(input);
      return behavior(input);
    },
  };
}

function okProvider(text = 'hi there', usage?: { inputTokens?: number; outputTokens?: number }): ModelProvider & { calls: ProviderGenerateInput[] } {
  return fakeProvider(() => Promise.resolve(usage ? { text, model: 'test-model', usage } : { text, model: 'test-model' }));
}

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<AgentError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe(code);
    return error as AgentError;
  }
  throw new Error(`expected rejection with ${code}`);
}

// --- request validation ---------------------------------------------------

describe('request validation', () => {
  it('accepts a valid request and detaches it from the caller object', () => {
    const raw = validRequest();
    const validated = validateAgentRequest(raw);
    expect(validated).toEqual(raw);
    expect(validated.messages).not.toBe(raw['messages']);
    (raw['messages'] as unknown[]).push({ role: 'user', content: 'mutated' });
    expect(validated.messages).toHaveLength(1);
  });
  it.each([null, undefined, 42, 'req', [], [{ requestId: 'x' }]])('rejects non-object %j', (raw) => {
    expect(() => validateAgentRequest(raw)).toThrowError(AgentError);
  });
  it('rejects each missing top-level field', () => {
    for (const key of ['requestId', 'userId', 'messages', 'config'] as const) {
      const raw = validRequest();
      delete raw[key];
      expect(() => validateAgentRequest(raw)).toThrowError(AgentError);
    }
  });
  it('rejects empty and overlong identifiers', () => {
    expect(() => validateAgentRequest(validRequest({ requestId: '' }))).toThrowError(AgentError);
    expect(() => validateAgentRequest(validRequest({ userId: '' }))).toThrowError(AgentError);
    expect(() => validateAgentRequest(validRequest({ requestId: 'r'.repeat(129) }))).toThrowError(AgentError);
    expect(() => validateAgentRequest(validRequest({ userId: 'u'.repeat(129) }))).toThrowError(AgentError);
  });
  it('rejects empty, excessive, or non-array message lists', () => {
    expect(() => validateAgentRequest(validRequest({ messages: [] }))).toThrowError(AgentError);
    expect(() => validateAgentRequest(validRequest({ messages: 'nope' }))).toThrowError(AgentError);
    const many = Array.from({ length: MAX_MESSAGES + 1 }, () => ({ role: 'user', content: 'x' }));
    expect(() => validateAgentRequest(validRequest({ messages: many }))).toThrowError(AgentError);
    const max = Array.from({ length: MAX_MESSAGES }, () => ({ role: 'user', content: 'x' }));
    expect(validateAgentRequest(validRequest({ messages: max })).messages).toHaveLength(MAX_MESSAGES);
  });
  it.each([['tool'], [''], [null], [undefined], [{ role: 'user' }]])('rejects invalid role %j', (role) => {
    expect(() => validateAgentRequest(validRequest({ messages: [{ role, content: 'x' }] }))).toThrowError(AgentError);
  });
  it('rejects non-string and oversized content', () => {
    expect(() => validateAgentRequest(validRequest({ messages: [{ role: 'user', content: 42 }] }))).toThrowError(AgentError);
    expect(() =>
      validateAgentRequest(validRequest({ messages: [{ role: 'user', content: 'x'.repeat(MAX_MESSAGE_CHARS + 1) }] })),
    ).toThrowError(AgentError);
  });
  it('rejects excessive total context', () => {
    const big = 'x'.repeat(20_000);
    const messages = Array.from({ length: 6 }, () => ({ role: 'user', content: big }));
    expect(6 * 20_000).toBeGreaterThan(MAX_TOTAL_CONTENT_CHARS);
    expect(() => validateAgentRequest(validRequest({ messages }))).toThrowError(AgentError);
  });
  it('rejects invalid generation limits', () => {
    const config = (patch: Record<string, unknown>) => validRequest({ config: { systemPrompt: 's', model: 'm', ...patch } });
    for (const maxOutputTokens of [0, -1, 1.5, '100', Number.NaN, MAX_OUTPUT_TOKENS + 1]) {
      expect(() => validateAgentRequest(config({ maxOutputTokens }))).toThrowError(AgentError);
    }
    for (const temperature of [-0.5, 2.5, Number.NaN, Number.POSITIVE_INFINITY, 'warm']) {
      expect(() => validateAgentRequest(config({ temperature }))).toThrowError(AgentError);
    }
    expect(() => validateAgentRequest(config({ systemPrompt: 'x'.repeat(MAX_SYSTEM_PROMPT_CHARS + 1) }))).toThrowError(AgentError);
    expect(() => validateAgentRequest(config({ model: '' }))).toThrowError(AgentError);
    expect(() => validateAgentRequest(config({ model: 'm'.repeat(MAX_MODEL_ID_CHARS + 1) }))).toThrowError(AgentError);
    expect(validateAgentRequest(config({ maxOutputTokens: 1, temperature: 0 })).config).toMatchObject({ maxOutputTokens: 1, temperature: 0 });
    expect(validateAgentRequest(config({ temperature: 2 })).config.temperature).toBe(2);
  });
  it('accepts bounded primitive metadata and rejects the rest', () => {
    const meta = { source: 'test', attempt: 2, urgent: true };
    const validated = validateAgentRequest(validRequest({ messages: [{ role: 'user', content: 'x', metadata: meta }] }));
    expect(validated.messages[0]?.metadata).toEqual(meta);
    const tooMany: Record<string, number> = {};
    for (let i = 0; i < MAX_METADATA_KEYS + 1; i += 1) tooMany[`k${i}`] = i;
    expect(() => validateAgentRequest(validRequest({ messages: [{ role: 'user', content: 'x', metadata: tooMany }] }))).toThrowError(
      AgentError,
    );
    expect(() =>
      validateAgentRequest(validRequest({ messages: [{ role: 'user', content: 'x', metadata: { ['k'.repeat(65)]: 1 } }] })),
    ).toThrowError(AgentError);
    for (const metadata of [[], 'meta', { nested: { deep: 1 } }, { list: [1] }, { nothing: null }]) {
      expect(() => validateAgentRequest(validRequest({ messages: [{ role: 'user', content: 'x', metadata }] }))).toThrowError(
        AgentError,
      );
    }
  });
  it('rejects prototype-pollution keys without polluting', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const message = JSON.parse(`{"role":"user","content":"x","metadata":{"${key}":{"polluted":true}}}`) as unknown;
      expect(() => validateAgentRequest(validRequest({ messages: [message] }))).toThrowError(AgentError);
    }
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
  it('runAgent rejects invalid requests with a stable error', async () => {
    const error = await rejectsWithCode(runAgent({ nope: true }, okProvider()), 'invalid_request');
    expect(error.message).toBe('Invalid agent request');
  });
});

// --- normalization --------------------------------------------------------

describe('message normalization', () => {
  it('prepends the system prompt and preserves caller order', () => {
    const request = validateAgentRequest(
      validRequest({
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'second' },
          { role: 'system', content: 'caller note' },
          { role: 'user', content: 'third' },
        ],
      }),
    );
    expect(buildProviderMessages(request)).toEqual([
      { role: 'system', content: 'You are HawkTalk.' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'system', content: 'caller note' },
      { role: 'user', content: 'third' },
    ]);
  });
  it('drops empty messages and omits an empty system prompt', () => {
    const request = validateAgentRequest(
      validRequest({
        messages: [{ role: 'user', content: '' }, { role: 'user', content: 'kept' }],
        config: { systemPrompt: '', model: 'm' },
      }),
    );
    expect(buildProviderMessages(request)).toEqual([{ role: 'user', content: 'kept' }]);
  });
  it('rejects a context with no usable content', () => {
    const request = validateAgentRequest(
      validRequest({ messages: [{ role: 'user', content: '' }], config: { systemPrompt: '', model: 'm' } }),
    );
    expect(() => buildProviderMessages(request)).toThrowError(AgentError);
  });
  it('strips metadata from provider messages', () => {
    const request = validateAgentRequest(
      validRequest({ messages: [{ role: 'user', content: 'x', metadata: { tag: 't' } }] }),
    );
    const [message] = buildProviderMessages(request);
    expect(Object.keys(message ?? {}).sort()).toEqual(['content', 'role']);
  });
});

// --- provider abstraction -------------------------------------------------

describe('provider abstraction', () => {
  it('returns a normalized response and a well-formed provider input', async () => {
    const provider = okProvider('answer!', { inputTokens: 10, outputTokens: 3 });
    const response = await runAgent(
      validRequest({ config: { systemPrompt: 'sys', model: 'm1', maxOutputTokens: 500, temperature: 0.5 } }),
      provider,
    );
    expect(response).toEqual({ requestId: 'req-1', text: 'answer!', model: 'test-model', usage: { inputTokens: 10, outputTokens: 3 } });
    expect(isAgentResponse(response)).toBe(true);
    expect(provider.calls).toHaveLength(1);
    const input = provider.calls[0];
    expect(input?.model).toBe('m1');
    expect(input?.systemPrompt).toBe('sys');
    expect(input?.maxOutputTokens).toBe(500);
    expect(input?.temperature).toBe(0.5);
    expect(input?.messages).toEqual([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }]);
    expect(input?.signal).toBeInstanceOf(AbortSignal);
  });
  it('applies the default output budget', async () => {
    const provider = okProvider();
    await runAgent(validRequest(), provider);
    expect(provider.calls[0]?.maxOutputTokens).toBe(DEFAULT_OUTPUT_TOKENS);
  });
  it('omits usage when the provider reports none', async () => {
    const response = await runAgent(validRequest(), okProvider());
    expect('usage' in response).toBe(false);
  });
  it.each([
    ['unavailable', 'provider_unavailable', 'Model provider unavailable'],
    ['timeout', 'provider_timeout', 'Model provider timed out'],
    ['upstream', 'provider_failure', 'Model provider failed'],
    ['malformed', 'provider_malformed', 'Model provider returned an invalid result'],
  ] as const)('maps provider %s to %s without leaking details', async (code, expected, message) => {
    const provider = fakeProvider(() => Promise.reject(new ProviderError(code)));
    const error = await rejectsWithCode(runAgent(validRequest(), provider), expected);
    expect(error.message).toBe(message);
  });
  it('maps unknown provider throwables to internal without leaking', async () => {
    const provider = fakeProvider(() => Promise.reject(new Error('connection to sk-secret-internal exploded')));
    const error = await rejectsWithCode(runAgent(validRequest(), provider), 'internal');
    expect(error.message).toBe('Internal agent failure');
    expect(error.message).not.toContain('sk-secret');
  });
  it('maps non-error throws to internal', async () => {
    const provider = fakeProvider(() => Promise.reject('just a string'));
    await rejectsWithCode(runAgent(validRequest(), provider), 'internal');
  });
  it.each([
    ['null result', null],
    ['empty object', {}],
    ['empty text', { text: '', model: 'm' }],
    ['non-string text', { text: 42, model: 'm' }],
    ['oversized text', { text: 'x'.repeat(MAX_PROVIDER_TEXT_CHARS + 1), model: 'm' }],
    ['missing model', { text: 't' }],
    ['bad usage shape', { text: 't', model: 'm', usage: 'lots' }],
    ['negative tokens', { text: 't', model: 'm', usage: { outputTokens: -1 } }],
    ['fractional tokens', { text: 't', model: 'm', usage: { inputTokens: 1.5 } }],
  ])('rejects malformed provider result: %s', async (_label, result) => {
    const provider = fakeProvider(() => Promise.resolve(result as unknown as ProviderGenerateResult));
    await rejectsWithCode(runAgent(validRequest(), provider), 'provider_malformed');
  });
  it('times out a hanging provider', async () => {
    const provider = fakeProvider(() => new Promise<ProviderGenerateResult>(() => undefined));
    await rejectsWithCode(runAgent(validRequest(), provider, { timeoutMs: 20 }), 'provider_timeout');
  });
  it('rejects invalid engine options and providers', async () => {
    const provider = okProvider();
    for (const timeoutMs of [0, -5, 1.5, Number.NaN, 300_001]) {
      await rejectsWithCode(runAgent(validRequest(), provider, { timeoutMs }), 'invalid_request');
    }
    for (const bad of [null, {}, { generate: 'x' }, { id: '', generate: () => Promise.resolve({ text: 't', model: 'm' }) }]) {
      await rejectsWithCode(runAgent(validRequest(), bad as unknown), 'internal');
    }
  });
  it('is deterministic for identical requests', async () => {
    const provider = okProvider('same');
    const first = await runAgent(validRequest(), provider);
    const second = await runAgent(validRequest(), provider);
    expect(first).toEqual(second);
  });
  it('performs no network access', async () => {
    const network = vi.fn(() => Promise.reject(new Error('must not be called')));
    vi.stubGlobal('fetch', network);
    try {
      const response = await runAgent(validRequest(), okProvider('offline ok'));
      expect(response.text).toBe('offline ok');
      expect(network).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// --- error model ----------------------------------------------------------

describe('error model', () => {
  it('exposes stable codes with generic messages', () => {
    expect(new AgentError('invalid_request').message).toBe('Invalid agent request');
    expect(new AgentError('internal').message).toBe('Internal agent failure');
  });
  it('passes AgentError through the mapper untouched', () => {
    const original = new AgentError('provider_timeout');
    expect(toAgentError(original)).toBe(original);
  });
  it('rejects the AgentResponse guard for non-responses', () => {
    expect(isAgentResponse(null)).toBe(false);
    expect(isAgentResponse({ text: 'x' })).toBe(false);
    expect(isAgentResponse({ requestId: 'r', text: 'x', model: 'm' })).toBe(true);
  });
  it('carries only the stable code, no payload', () => {
    const error = toAgentError(new ProviderError('upstream'));
    expect(error.code).toBe('provider_failure');
    // `name` is the standard error discriminator; `code` is the only payload.
    expect(Object.keys(error).sort()).toEqual(['code', 'name']);
    expect(error.message).toBe('Model provider failed');
  });
});

// --- isolation ------------------------------------------------------------

describe('core isolation', () => {
  it('runs with no Telegram, D1, or Worker runtime globals required', async () => {
    expect((globalThis as Record<string, unknown>)['DB']).toBeUndefined();
    const response = await runAgent(
      { requestId: 'iso', userId: 'u-iso', messages: [{ role: 'user', content: 'ping' }], config: { systemPrompt: '', model: 'm' } },
      okProvider('pong'),
    );
    expect(response).toMatchObject({ requestId: 'iso', text: 'pong' });
  });
  it('accepts a minimal caller-supplied context without persistence', async () => {
    const request = { requestId: 'r', userId: 'u', messages: [{ role: 'user', content: 'hi' }], config: { systemPrompt: '', model: 'm' } };
    const validated = validateAgentRequest(request) as AgentRequest;
    expect(validated.messages).toHaveLength(1);
    const response = await runAgent(request, okProvider('hello'));
    expect(response.text).toBe('hello');
  });
});
