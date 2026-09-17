// Agent Core types (Phase 3).
// Provider-neutral, transport-neutral, runtime-neutral. This module knows
// nothing about Telegram, D1, Wrangler, HTTP, or any concrete AI provider.
// A future Telegram adapter translates transport updates into AgentRequest;
// a future AI Router (Phase 4) implements the ModelProvider port.

/** Conversation roles understood by the core. Extensible later (tool, etc.). */
export type AgentMessageRole = 'system' | 'user' | 'assistant';

/** Metadata values are primitives only: no nested objects, no functions. */
export type AgentMetadataValue = string | number | boolean;

export interface AgentMessage {
  role: AgentMessageRole;
  content: string;
  metadata?: Record<string, AgentMetadataValue> | undefined;
}

/** Provider-neutral generation configuration. `model` is an opaque identifier. */
export interface AgentConfig {
  systemPrompt: string;
  model: string;
  maxOutputTokens?: number | undefined;
  temperature?: number | undefined;
}

/** Stable internal representation of one agent invocation. */
export interface AgentRequest {
  /** Correlation ID supplied by the application layer (opaque to the core). */
  requestId: string;
  /** Stable caller identifier, opaque to the core (never a credential). */
  userId: string;
  /** Explicitly supplied conversation context. The core stores nothing. */
  messages: AgentMessage[];
  config: AgentConfig;
}

/** Provider-neutral agent result. */
export interface AgentResponse {
  requestId: string;
  text: string;
  model: string;
  usage?: AgentUsage | undefined;
}

export interface AgentUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

// --- Bounds (all validation limits live here, in one place) ---------------

export const MAX_REQUEST_ID_CHARS = 128;
export const MAX_USER_ID_CHARS = 128;
export const MAX_MESSAGES = 100;
export const MAX_MESSAGE_CHARS = 20_000;
export const MAX_TOTAL_CONTENT_CHARS = 100_000;
export const MAX_SYSTEM_PROMPT_CHARS = 8_000;
export const MAX_MODEL_ID_CHARS = 128;
export const DEFAULT_OUTPUT_TOKENS = 1_024;
export const MAX_OUTPUT_TOKENS = 16_384;
export const MIN_TEMPERATURE = 0;
export const MAX_TEMPERATURE = 2;
export const MAX_METADATA_KEYS = 16;
export const MAX_METADATA_KEY_CHARS = 64;
/** Safety cap on provider-supplied text (untrusted until validated). */
export const MAX_PROVIDER_TEXT_CHARS = 200_000;
