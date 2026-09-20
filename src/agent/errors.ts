import type { AgentResponse } from './types';

// Stable internal error model (Phase 3).
// Callers switch on `code` only. Messages are generic by design: raw upstream
// bodies, credentials, prompts, and stack traces never leave the core.

export type AgentErrorCode =
  | 'invalid_request'
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'provider_failure'
  | 'provider_malformed'
  | 'internal';

const AGENT_ERROR_MESSAGES: Record<AgentErrorCode, string> = {
  invalid_request: 'Invalid agent request',
  provider_unavailable: 'Model provider unavailable',
  provider_timeout: 'Model provider timed out',
  provider_failure: 'Model provider failed',
  provider_malformed: 'Model provider returned an invalid result',
  internal: 'Internal agent failure',
};

export class AgentError extends Error {
  readonly code: AgentErrorCode;

  constructor(code: AgentErrorCode) {
    super(AGENT_ERROR_MESSAGES[code]);
    this.name = 'AgentError';
    this.code = code;
  }
}

/** Failure modes a ModelProvider implementation may report. */
export type ProviderErrorCode = 'unavailable' | 'timeout' | 'upstream' | 'malformed';

/**
 * Thrown by ModelProvider implementations. `detail` is for the provider's own
 * internal use and is NEVER propagated into AgentError or any response —
 * the engine maps the code to a generic AgentError.
 *
 * `httpStatus` is an optional machine-readable classification for upstream
 * HTTP failures (e.g. 429 vs 401 vs 5xx) so routers can apply cooldown /
 * failover policy. It is undefined for network, timeout, and malformed
 * failures. The engine ignores it; only routing policy reads it.
 *
 * TEMP-DIAGNOSTIC EXTENSION (remove after production triage): `phase`,
 * `detail`, and `contentType` carry bounded, sanitized diagnostic metadata:
 * - phase: where the attempt failed — 'network' (fetch/transport), 'http'
 *   (non-2xx response), 'parse' (2xx payload not parseable), 'schema'
 *   (parsed payload failed structural validation).
 * - detail: sanitized upstream error message, printable-ASCII only,
 *   truncated to 200 characters. NEVER contains credentials; upstream error
 *   bodies describe the provider's own rejection, not our secrets.
 * - contentType: the upstream Content-Type response header value, when a
 *   response was received.
 */
export type ProviderFailurePhase = 'network' | 'http' | 'parse' | 'schema';

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly httpStatus?: number | undefined;
  readonly phase?: ProviderFailurePhase | undefined;
  readonly detail?: string | undefined;
  readonly contentType?: string | undefined;

  constructor(
    code: ProviderErrorCode,
    httpStatus?: number | undefined,
    meta?: { phase?: ProviderFailurePhase; detail?: string; contentType?: string },
  ) {
    super(`Provider error: ${code}`);
    this.name = 'ProviderError';
    this.code = code;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
    if (meta?.phase !== undefined) this.phase = meta.phase;
    if (meta?.detail !== undefined) this.detail = meta.detail;
    if (meta?.contentType !== undefined) this.contentType = meta.contentType;
  }
}

const PROVIDER_TO_AGENT: Record<ProviderErrorCode, AgentErrorCode> = {
  unavailable: 'provider_unavailable',
  timeout: 'provider_timeout',
  upstream: 'provider_failure',
  malformed: 'provider_malformed',
};

/** Maps a provider failure to the public stable error. Unknown throwables → internal. */
export function toAgentError(error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  if (error instanceof ProviderError) return new AgentError(PROVIDER_TO_AGENT[error.code]);
  return new AgentError('internal');
}

// Type guard for tests and future adapters: every success value must satisfy this.
export function isAgentResponse(value: unknown): value is AgentResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { requestId?: unknown }).requestId === 'string' &&
    typeof (value as { text?: unknown }).text === 'string' &&
    typeof (value as { model?: unknown }).model === 'string'
  );
}
