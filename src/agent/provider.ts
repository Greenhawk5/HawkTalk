// Model/provider port (Phase 3).
// This is the ONLY seam between the Agent Core and text generation. A future
// Phase 4 AI Router implements this interface; concrete vendor adapters
// (OpenRouter, Z.AI, OpenAI-compatible) sit behind it.
//
// Credential boundary: provider credentials NEVER cross this interface.
// Implementations obtain keys from their own credential/key manager (env,
// config store, Admin CMS). The core supplies only an opaque `model`
// identifier and generation parameters.

/** Normalized conversation message handed to the provider. */
export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ProviderGenerateInput {
  /** Correlation ID for the provider's own diagnostics (opaque string). */
  requestId: string;
  /** Opaque model identifier selected by the application layer / router. */
  model: string;
  /** Active system instructions (already validated + bounded by the core). */
  systemPrompt: string;
  /** Normalized conversation context, oldest first. */
  messages: ProviderMessage[];
  maxOutputTokens: number;
  temperature?: number | undefined;
  /** Aborted when the engine's call budget expires. Honor it if possible. */
  signal?: AbortSignal | undefined;
}

export interface ProviderUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

export interface ProviderGenerateResult {
  text: string;
  model: string;
  usage?: ProviderUsage | undefined;
}

export interface ModelProvider {
  /** Stable provider identifier (e.g. 'router', never a credential). */
  readonly id: string;
  generate(input: ProviderGenerateInput): Promise<ProviderGenerateResult>;
}
