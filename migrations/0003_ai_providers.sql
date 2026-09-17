-- Phase 4: AI provider layer.
-- providers: non-secret, dynamically manageable provider configuration.
-- provider_credentials: one row per API key. The secret column holds ONLY the
-- versioned AES-GCM sealed envelope (see src/ai/crypto.ts) — never plaintext.

CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  base_url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  weight INTEGER NOT NULL DEFAULT 100,
  default_model TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL DEFAULT 30000,
  max_credential_attempts INTEGER NOT NULL DEFAULT 3,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE provider_credentials (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  weight INTEGER NOT NULL DEFAULT 100,
  secret_ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_provider_credentials_provider ON provider_credentials(provider_id);
