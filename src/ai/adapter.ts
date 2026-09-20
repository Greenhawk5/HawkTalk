import { ProviderError } from '../agent/errors';
import type { ModelProvider, ProviderGenerateInput, ProviderGenerateResult } from '../agent/provider';

// OpenAI-compatible chat-completions adapter (Phase 4).
// One reusable protocol adapter serves OpenAI-compatible endpoints — including
// OpenRouter and Z.AI via their OpenAI-compatible base URLs, which differ only
// in configuration (base URL + key), not in protocol. If a provider ever needs
// materially different semantics, it gets its own adapter; nothing here leaks
// into the Agent Core.
//
// Security: the API key is constructor-injected for a single routing attempt,
// used only in the Authorization header, and never logged, cached, or included
// in errors. Upstream bodies are validated and never propagated.

export const OPENAI_CHAT_COMPLETIONS_PATH = '/chat/completions';
export const DEFAULT_ADAPTER_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
// TEMP-DIAGNOSTIC (remove after production triage): bounded sanitized detail.
const MAX_DETAIL_CHARS = 200;

function sanitizeDetail(text: string): string {
  return text.replace(/[^\x20-\x7E]/g, '?').slice(0, MAX_DETAIL_CHARS);
}

export interface OpenAICompatibleAdapterOptions {
  id: string;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class OpenAICompatibleAdapter implements ModelProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OpenAICompatibleAdapterOptions) {
    if (typeof options.id !== 'string' || options.id.length === 0) throw new Error('Adapter id is required');
    if (typeof options.baseUrl !== 'string' || options.baseUrl.length === 0) throw new Error('Adapter base URL is required');
    if (typeof options.apiKey !== 'string' || options.apiKey.length === 0) throw new Error('Adapter API key is required');
    const timeoutMs = options.timeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Adapter timeout must be a positive integer');
    this.id = options.id;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = timeoutMs;
  }

  async generate(input: ProviderGenerateInput): Promise<ProviderGenerateResult> {
    if (input.signal?.aborted === true) throw new ProviderError('timeout', undefined, { phase: 'network' });

    const body = JSON.stringify({
      model: input.model,
      messages: [
        ...(input.systemPrompt.length > 0 ? [{ role: 'system', content: input.systemPrompt }] : []),
        ...input.messages.map((message) => ({ role: message.role, content: message.content })),
      ],
      max_tokens: input.maxOutputTokens,
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onCallerAbort = (): void => controller.abort();
    input.signal?.addEventListener('abort', onCallerAbort, { once: true });

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${OPENAI_CHAT_COMPLETIONS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      // Aborts (own timeout or caller cancellation) are timeouts; transport
      // failures are upstream. Neither carries detail outward.
      if (typeof error === 'object' && error !== null && 'name' in error && (error as { name: unknown }).name === 'AbortError') {
        throw new ProviderError('timeout', undefined, { phase: 'network' });
      }
      // TEMP-DIAGNOSTIC (remove after production triage): network-phase
      // classification with a sanitized bounded transport message (e.g.
      // \"TypeError: fetch failed\") — never headers, keys, or bodies.
      throw new ProviderError('upstream', undefined, {
        phase: 'network',
        detail: sanitizeDetail(error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
      });
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onCallerAbort);
    }

    if (!response.ok) {
      // Drain the failure body ONLY for bounded diagnostics: sanitized,
      // ≤200 printable characters. Never propagated to users or Agent Core.
      const contentType = response.headers.get('content-type') ?? undefined;
      let detail: string | undefined;
      try {
        detail = sanitizeDetail(await response.text());
      } catch {
        detail = undefined;
      }
      // Status alone still drives policy; the body is diagnostic metadata only.
      throw new ProviderError('upstream', response.status, { phase: 'http', ...(detail !== undefined ? { detail } : {}), ...(contentType !== undefined ? { contentType } : {}) });
    }

    let payload: unknown;
    let rawText: string | undefined;
    const contentType = response.headers.get('content-type') ?? undefined;
    try {
      rawText = await response.text();
      if (rawText.length === 0 || rawText.length > MAX_RESPONSE_BYTES) {
        // TEMP-DIAGNOSTIC (remove after production triage): parse-phase metadata.
        throw new ProviderError('malformed', undefined, {
          phase: 'parse',
          detail: rawText.length === 0 ? 'empty body' : 'body exceeds size limit',
          ...(contentType !== undefined ? { contentType } : {}),
        });
      }
      payload = JSON.parse(rawText) as unknown;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      // TEMP-DIAGNOSTIC (remove after production triage): parse-phase metadata.
      throw new ProviderError('malformed', undefined, {
        phase: 'parse',
        ...(rawText !== undefined ? { detail: sanitizeDetail(rawText) } : {}),
        ...(contentType !== undefined ? { contentType } : {}),
      });
    }

    // TEMP-DIAGNOSTIC (remove after production triage): schema-phase metadata.
    if (!isRecord(payload)) throw new ProviderError('malformed', undefined, { phase: 'schema', detail: 'payload not an object' });
    const choices = payload['choices'];
    if (!Array.isArray(choices) || choices.length === 0) throw new ProviderError('malformed', undefined, { phase: 'schema', detail: 'missing or empty choices' });
    const first = choices[0];
    if (!isRecord(first)) throw new ProviderError('malformed', undefined, { phase: 'schema', detail: 'first choice not an object' });
    const message = first['message'];
    if (!isRecord(message) || typeof message['content'] !== 'string' || (message['content'] as string).length === 0)
      throw new ProviderError('malformed', undefined, { phase: 'schema', detail: 'missing or empty message content' });

    const result: ProviderGenerateResult = {
      text: message['content'] as string,
      model: typeof payload['model'] === 'string' && (payload['model'] as string).length > 0 ? (payload['model'] as string) : input.model,
    };
    const usage = payload['usage'];
    if (isRecord(usage)) {
      const inputTokens = usage['prompt_tokens'];
      const outputTokens = usage['completion_tokens'];
      if (
        (inputTokens !== undefined && (!Number.isInteger(inputTokens) || (inputTokens as number) < 0)) ||
        (outputTokens !== undefined && (!Number.isInteger(outputTokens) || (outputTokens as number) < 0))
      ) {
        // TEMP-DIAGNOSTIC (remove after production triage): schema-phase metadata.
        throw new ProviderError('malformed', undefined, { phase: 'schema', detail: 'invalid usage token fields' });
      }
      if (inputTokens !== undefined || outputTokens !== undefined) {
        result.usage = {};
        if (inputTokens !== undefined) result.usage.inputTokens = inputTokens as number;
        if (outputTokens !== undefined) result.usage.outputTokens = outputTokens as number;
      }
    }
    return result;
  }
}
