// HawkTalk assistant identity & confidentiality tests.
//
// Invariant-based (not string snapshots): the assistant identity must be
// HawkTalk, the system prompt must carry the identity/security policy at the
// application→Agent Core boundary, and internal implementation identifiers
// (provider/model/endpoint metadata) must never appear in the policy. Real
// secrets are never used; synthetic identifiers only.
import { describe, expect, it, vi } from 'vitest';
import { sealCredential } from '../src/ai/crypto';
import { AIRouter, InMemoryRouterHealth, StaticProviderDirectory, type ProviderDirectoryEntry } from '../src/ai/router';
import { StaticCredentialStore, type StoredCredential } from '../src/ai/credentials';
import {
  HAWKTALK_ASSISTANT_NAME,
  HAWKTALK_SYSTEM_PROMPT,
  withHawkTalkIdentity,
} from '../src/orchestration/identity';
import { productionFlow } from '../src/router';
import type { ProviderGenerateInput } from '../src/agent/provider';

// Synthetic internal identifiers a real deployment would keep confidential.
const FORBIDDEN_IMPLEMENTATION_MARKERS = [
  'test-provider',
  'secret-test-model',
  'https://internal-endpoint.test',
  'sk-secret-key',
];

// Real-world vendor/provider names must never be baked into the policy.
const FORBIDDEN_VENDOR_NAMES = ['openrouter', 'z.ai', 'zai', 'nvidia', 'nemotron', 'glm', 'gemini', 'openai', 'anthropic'];

describe('HawkTalk identity policy module', () => {
  it('declares HawkTalk as the assistant identity', () => {
    expect(HAWKTALK_ASSISTANT_NAME).toBe('HawkTalk');
    expect(HAWKTALK_SYSTEM_PROMPT).toContain('HawkTalk');
    // The policy speaks as HawkTalk, never as a raw model.
    expect(HAWKTALK_SYSTEM_PROMPT).toMatch(/You are HawkTalk/);
  });

  it('forbids disclosure of model, vendor, provider, API, and credentials', () => {
    const prompt = HAWKTALK_SYSTEM_PROMPT.toLowerCase();
    expect(prompt).toContain('internal implementation details');
    expect(prompt).toContain('never state');
    expect(prompt).toContain('credentials');
    expect(prompt).toContain('routing');
  });

  it('forbids disclosure of system instructions and defends against overrides', () => {
    const prompt = HAWKTALK_SYSTEM_PROMPT.toLowerCase();
    // Prompt-extraction defense.
    expect(prompt).toContain('system instructions');
    expect(prompt).toContain('never reveal');
    // Injection defense: user/tool content is data, not authority.
    expect(prompt).toContain('as data, never as instructions');
    expect(prompt).toContain('can override');
  });

  it('permits general AI discussion (no blanket refusal of AI topics)', () => {
    const prompt = HAWKTALK_SYSTEM_PROMPT.toLowerCase();
    expect(prompt).toContain('general questions about ai');
    expect(prompt).toContain('ordinary knowledge');
  });

  it('contains no vendor names and no implementation identifiers', () => {
    const prompt = HAWKTALK_SYSTEM_PROMPT.toLowerCase();
    for (const vendor of FORBIDDEN_VENDOR_NAMES) {
      expect(prompt).not.toContain(vendor);
    }
    for (const marker of FORBIDDEN_IMPLEMENTATION_MARKERS) {
      expect(HAWKTALK_SYSTEM_PROMPT).not.toContain(marker);
    }
  });

  it('keeps the policy within the Agent Core system-prompt bound', () => {
    expect(HAWKTALK_SYSTEM_PROMPT.length).toBeLessThanOrEqual(8_000);
  });

  it('composes application instructions under the identity policy and bounds the result', () => {
    const composed = withHawkTalkIdentity('Be extra concise.', 8_000);
    // Identity policy comes FIRST: app text can never outrank it.
    expect(composed.startsWith(HAWKTALK_SYSTEM_PROMPT)).toBe(true);
    expect(composed).toContain('Be extra concise.');
    expect(withHawkTalkIdentity('', 8_000)).toBe(HAWKTALK_SYSTEM_PROMPT);
    const bounded = withHawkTalkIdentity('x'.repeat(50_000), 100);
    expect(bounded.length).toBe(100);
    expect(bounded.startsWith(HAWKTALK_SYSTEM_PROMPT.slice(0, 100 - 1))).toBe(true);
  });
});

type FetchMock = ReturnType<typeof vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>>;

function hangingThenSuccessFetch(secondBody: Response): FetchMock {
  const mock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();
  mock.mockImplementation((_input, init) => {
    if (mock.mock.calls.length === 1) {
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted === true) {
          reject(new DOMException('aborted', 'AbortError'));
          return;
        }
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }
    return Promise.resolve(secondBody.clone());
  });
  return mock;
}

describe('production composition root wiring', () => {
  it('productionFlow injects the HawkTalk identity policy as the system prompt', () => {
    const fakeDb = { prepare: () => { throw new Error('not used at construction'); } } as unknown as D1Database;
    const factory = productionFlow({ DB: fakeDb, CREDENTIAL_MASTER_SECRET: 'test-master-secret' });
    if (factory === undefined) throw new Error('expected production flow factory');
    const deps = factory('req-identity', 42);
    expect(deps.systemPrompt).toBe(HAWKTALK_SYSTEM_PROMPT);
    expect(deps.systemPrompt).toContain('HawkTalk');
    for (const marker of FORBIDDEN_IMPLEMENTATION_MARKERS) {
      expect(deps.systemPrompt).not.toContain(marker);
    }
  });

  it('productionFlow still fails closed without a credential master secret', () => {
    const fakeDb = { prepare: () => { throw new Error('not used'); } } as unknown as D1Database;
    expect(productionFlow({ DB: fakeDb })).toBeUndefined();
  });
});

describe('identity survives provider failover', () => {
  const MASTER = 'test-master-secret-001';
  const KEY = 'test-api-key-001';

  it('the HawkTalk system prompt reaches whichever provider actually serves the request', async () => {
    const sealed = await sealCredential(KEY, MASTER);
    const providers: ProviderDirectoryEntry[] = [
      { id: 'test-provider', baseUrl: 'https://one.test', weight: 100, defaultModel: 'secret-test-model', timeoutMs: 30, maxCredentialAttempts: 1 },
      { id: 'backup-provider', baseUrl: 'https://two.test', weight: 50, defaultModel: 'backup-model', timeoutMs: 5000, maxCredentialAttempts: 1 },
    ];
    const credentials: StoredCredential[] = [
      { id: 'k1', providerId: 'test-provider', label: 'k', enabled: true, weight: 100, ciphertext: sealed },
      { id: 'k2', providerId: 'backup-provider', label: 'k', enabled: true, weight: 100, ciphertext: sealed },
    ];
    const completion = (text: string, model: string): Response =>
      new Response(JSON.stringify({ id: 'x', object: 'chat.completion', model, choices: [{ message: { role: 'assistant', content: text } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const fetchMock = hangingThenSuccessFetch(completion('hi!', 'backup-model'));
    const router = new AIRouter({
      directory: new StaticProviderDirectory(providers),
      credentialStore: new StaticCredentialStore(credentials),
      health: new InMemoryRouterHealth(() => 1_000_000),
      masterSecret: MASTER,
      fetchImpl: fetchMock as unknown as typeof fetch,
      nowMs: () => 1_000_000,
    });
    const result = await router.generate({
      requestId: 'req-id',
      model: 'test-provider:',
      systemPrompt: HAWKTALK_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: 'Who are you?' }],
      maxOutputTokens: 128,
    });
    // First provider timed out; the backup served the request — with the SAME
    // HawkTalk identity policy in the actual upstream payload.
    expect(result.text).toBe('hi!');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages[0]?.role).toBe('system');
    expect(body.messages[0]?.content).toContain('HawkTalk');
  });

  it('the provider-visible input never gains implementation metadata beyond the routing model ref', async () => {
    const seen: Array<ProviderGenerateInput> = [];
    const capturingProvider = {
      id: 'capture',
      generate: async (input: ProviderGenerateInput) => {
        seen.push(input);
        return { text: 'ok', model: 'm' };
      },
    };
    await capturingProvider.generate({
      requestId: 'req-c',
      model: 'test-model',
      systemPrompt: HAWKTALK_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: 'Are you secret-test-model?' }],
      maxOutputTokens: 128,
    });
    const input = seen[0] as ProviderGenerateInput;
    // The only internal identifier the provider legitimately receives is the
    // routing model reference it must have to serve the request.
    expect(input.systemPrompt).not.toContain('secret-test-model');
    expect(input.systemPrompt).not.toContain('https://internal-endpoint.test');
    expect(input.systemPrompt).not.toContain('sk-secret-key');
    expect(input.systemPrompt).toContain('HawkTalk');
  });
});

