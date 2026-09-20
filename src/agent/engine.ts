import { AgentError, toAgentError } from './errors';
import type { ModelProvider, ProviderGenerateInput, ProviderMessage } from './provider';
import type {
  AgentConfig,
  AgentMessage,
  AgentMessageRole,
  AgentMetadataValue,
  AgentRequest,
  AgentResponse,
} from './types';
import {
  DEFAULT_OUTPUT_TOKENS,
  MAX_MESSAGES,
  MAX_MESSAGE_CHARS,
  MAX_METADATA_KEYS,
  MAX_METADATA_KEY_CHARS,
  MAX_MODEL_ID_CHARS,
  MAX_OUTPUT_TOKENS,
  MAX_PROVIDER_TEXT_CHARS,
  MAX_REQUEST_ID_CHARS,
  MAX_SYSTEM_PROMPT_CHARS,
  MAX_TEMPERATURE,
  MAX_TOTAL_CONTENT_CHARS,
  MAX_USER_ID_CHARS,
  MIN_TEMPERATURE,
} from './types';

// Agent engine (Phase 3): validate → normalize context → provider → normalize.
// Stateless, dependency-injected, side-effect free. It performs no I/O, emits
// no logs, and never touches Telegram, D1, Wrangler, or the network. All
// failures surface as AgentError with a stable public code.

// Timeout ownership (post-incident fix):
// - The per-provider timeout lives in the ADAPTER (provider.timeout_ms, wired
//   by AIRouter). It is classified as ProviderError('timeout'), which AIRouter
//   treats as retryable and uses to fail over to the next eligible provider.
// - The engine watchdog below is the OVERALL agent-operation budget only. It
//   must stay strictly longer than the router's per-attempt budgets so a
//   provider timeout surfaces inside the router (provider_attempt_failed →
//   failover) instead of the watchdog preemptively winning the race and
//   terminating the whole operation as AgentError('provider_timeout').
//   It exists solely to bound the operation against providers that never
//   settle (ignore the abort signal), and it remains capped by MAX.
export const DEFAULT_AGENT_TIMEOUT_MS = 120_000;
export const MAX_AGENT_TIMEOUT_MS = 300_000;

export interface RunAgentOptions {
  timeoutMs?: number | undefined;
}

function fail(): never {
  throw new AgentError('invalid_request');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function boundedId(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) fail();
  return value;
}

function validateMetadata(value: unknown): Record<string, AgentMetadataValue> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) fail();
  const keys = Object.keys(value);
  if (keys.length > MAX_METADATA_KEYS) fail();
  const out: Record<string, AgentMetadataValue> = {};
  for (const key of keys) {
    if (key.length === 0 || key.length > MAX_METADATA_KEY_CHARS) fail();
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') fail();
    const entry: unknown = value[key];
    if (typeof entry !== 'string' && typeof entry !== 'number' && typeof entry !== 'boolean') fail();
    out[key] = entry;
  }
  return out;
}

function validateMessage(value: unknown): AgentMessage {
  if (!isPlainObject(value)) fail();
  const role = value['role'];
  if (role !== 'system' && role !== 'user' && role !== 'assistant') fail();
  const content = value['content'];
  if (typeof content !== 'string' || content.length > MAX_MESSAGE_CHARS) fail();
  const metadata = validateMetadata(value['metadata']);
  const message: AgentMessage = { role: role as AgentMessageRole, content };
  if (metadata !== undefined) message.metadata = metadata;
  return message;
}

function validateConfig(value: unknown): AgentConfig {
  if (!isPlainObject(value)) fail();
  const systemPrompt = value['systemPrompt'];
  if (typeof systemPrompt !== 'string' || systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS) fail();
  const model = boundedId(value['model'], MAX_MODEL_ID_CHARS);
  const config: AgentConfig = { systemPrompt, model };
  const maxOutputTokens = value['maxOutputTokens'];
  if (maxOutputTokens !== undefined) {
    if (typeof maxOutputTokens !== 'number' || !Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0 || maxOutputTokens > MAX_OUTPUT_TOKENS) fail();
    config.maxOutputTokens = maxOutputTokens;
  }
  const temperature = value['temperature'];
  if (temperature !== undefined) {
    if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < MIN_TEMPERATURE || temperature > MAX_TEMPERATURE) fail();
    config.temperature = temperature;
  }
  return config;
}

/** Validates untrusted input and returns a clean, caller-detached copy. */
export function validateAgentRequest(request: unknown): AgentRequest {
  if (!isPlainObject(request)) fail();
  const requestId = boundedId(request['requestId'], MAX_REQUEST_ID_CHARS);
  const userId = boundedId(request['userId'], MAX_USER_ID_CHARS);
  if (!Array.isArray(request['messages'])) fail();
  const messages = request['messages'];
  if (messages.length === 0 || messages.length > MAX_MESSAGES) fail();
  const validatedMessages = messages.map(validateMessage);
  const config = validateConfig(request['config']);

  let totalChars = config.systemPrompt.length;
  for (const message of validatedMessages) totalChars += message.content.length;
  if (totalChars > MAX_TOTAL_CONTENT_CHARS) fail();

  return { requestId, userId, messages: validatedMessages, config };
}

/** Builds the provider context: system prompt first, then non-empty messages in order. */
export function buildProviderMessages(request: AgentRequest): ProviderMessage[] {
  const out: ProviderMessage[] = [];
  if (request.config.systemPrompt.length > 0) {
    out.push({ role: 'system', content: request.config.systemPrompt });
  }
  for (const message of request.messages) {
    if (message.content.length === 0) continue;
    out.push({ role: message.role, content: message.content });
  }
  if (out.length === 0) throw new AgentError('invalid_request');
  return out;
}

function normalizeResult(requestId: string, result: unknown): AgentResponse {
  if (!isPlainObject(result)) throw new AgentError('provider_malformed');
  const text = result['text'];
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_PROVIDER_TEXT_CHARS) {
    throw new AgentError('provider_malformed');
  }
  const model = result['model'];
  if (typeof model !== 'string' || model.length === 0 || model.length > MAX_MODEL_ID_CHARS) {
    throw new AgentError('provider_malformed');
  }
  const response: AgentResponse = { requestId, text, model };
  const usage = result['usage'];
  if (usage !== undefined) {
    if (!isPlainObject(usage)) throw new AgentError('provider_malformed');
    const normalized: { inputTokens?: number; outputTokens?: number } = {};
    for (const key of ['inputTokens', 'outputTokens'] as const) {
      const tokens = usage[key];
      if (tokens !== undefined) {
        if (typeof tokens !== 'number' || !Number.isInteger(tokens) || tokens < 0) throw new AgentError('provider_malformed');
        normalized[key] = tokens;
      }
    }
    response.usage = normalized;
  }
  return response;
}

function validateProvider(provider: unknown): ModelProvider {
  if (
    typeof provider !== 'object' ||
    provider === null ||
    typeof (provider as { generate?: unknown }).generate !== 'function' ||
    typeof (provider as { id?: unknown }).id !== 'string' ||
    ((provider as { id: string }).id.length === 0)
  ) {
    throw new AgentError('internal');
  }
  return provider as ModelProvider;
}

/** Runs one agent invocation against the injected provider. */
export async function runAgent(request: unknown, provider: unknown, options: RunAgentOptions = {}): Promise<AgentResponse> {
  const validated = validateAgentRequest(request);
  const modelProvider = validateProvider(provider);

  // OVERALL operation budget (see the timeout-ownership note above). Not a
  // per-provider cap: AIRouter and the adapter own per-provider timing.
  const timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_AGENT_TIMEOUT_MS) {
    throw new AgentError('invalid_request');
  }

  const messages = buildProviderMessages(validated);
  const input: ProviderGenerateInput = {
    requestId: validated.requestId,
    model: validated.config.model,
    systemPrompt: validated.config.systemPrompt,
    messages,
    maxOutputTokens: validated.config.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS,
  };
  if (validated.config.temperature !== undefined) input.temperature = validated.config.temperature;

  const controller = new AbortController();
  input.signal = controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Last-resort watchdog: fire ONLY when the overall budget is exhausted
      // (e.g. a provider ignoring the abort signal). Per-provider timeouts are
      // handled earlier inside AIRouter/adapter and never reach this point.
      controller.abort();
      reject(new AgentError('provider_timeout'));
    }, timeoutMs);
  });

  try {
    // Promise.race subscribes to the provider promise immediately, so a late
    // rejection after a timeout win is still handled (no unhandled rejection).
    const result = await Promise.race([modelProvider.generate(input), timeout]);
    if (timer !== undefined) clearTimeout(timer);
    return normalizeResult(validated.requestId, result);
  } catch (error) {
    if (timer !== undefined) clearTimeout(timer);
    throw toAgentError(error);
  }
}
