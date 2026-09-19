export interface AppEnv {
  APP_ENV: 'development' | 'staging' | 'production';
  DB: D1Database;
  // Phase 2 Telegram secrets. Optional at the type level so /healthz and
  // non-Telegram paths keep working without them; the webhook handler fails
  // closed at request time when they are missing or empty. Values come from
  // `wrangler secret put` / `.dev.vars` — never from source or wrangler.toml.
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  // Phase 4/6: master secret for AI credential decryption. Optional at the
  // type level so /healthz keeps working; the conversational flow is only
  // wired when it is present (transport-only acknowledgement otherwise).
  CREDENTIAL_MASTER_SECRET?: string;
  // Phase 10: Cloudflare Workers AI binding for semantic-memory embeddings.
  // Optional: when absent, semantic memory is disabled (fail-closed).
  AI?: Ai;
  // Phase 10: Cloudflare Vectorize index binding for semantic-memory vector search.
  // Optional: when absent, semantic memory is disabled (fail-closed).
  VECTORIZE?: VectorizeIndex;
}

export function validateEnv(env: Partial<AppEnv>): asserts env is AppEnv {
  if (
    !['development', 'staging', 'production'].includes(env.APP_ENV ?? '') ||
    !env.DB ||
    typeof env.DB.prepare !== 'function'
  ) {
    throw new Error('Invalid environment configuration');
  }
}
