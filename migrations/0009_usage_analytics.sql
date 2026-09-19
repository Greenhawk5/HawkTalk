-- Phase 10: cost/reliability analytics foundation.
-- usage_events records one row per successful provider generation, owned by
-- the internal users.id. Token counts are provider-reported usage only;
-- microdollar estimates are server-computed from provider_prices, so history
-- stays stable when prices change. No message content, prompts, secrets, or
-- provider ciphertext are stored here.

CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL CHECK (length(provider_id) >= 1 AND length(provider_id) <= 64),
  vendor_model TEXT NOT NULL CHECK (length(vendor_model) >= 1 AND length(vendor_model) <= 128),
  request_id TEXT NOT NULL CHECK (length(request_id) >= 1 AND length(request_id) <= 128),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (typeof(input_tokens) = 'integer' AND input_tokens BETWEEN 0 AND 9007199254740991),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (typeof(output_tokens) = 'integer' AND output_tokens BETWEEN 0 AND 9007199254740991),
  estimated_cost_microdollars INTEGER NOT NULL DEFAULT 0 CHECK (typeof(estimated_cost_microdollars) = 'integer' AND estimated_cost_microdollars BETWEEN 0 AND 9007199254740991),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND julianday(created_at) IS NOT NULL)
);

CREATE INDEX idx_usage_events_user_time ON usage_events (user_id, created_at DESC, id ASC);
CREATE INDEX idx_usage_events_provider ON usage_events (provider_id, created_at DESC);

-- Optional per-model pricing (microdollars per 1M tokens). Rows are trusted
-- server-side configuration, editable by OWNER via the CMS. A missing row
-- means "price unknown": usage is still recorded, with cost 0.
CREATE TABLE provider_prices (
  provider_id TEXT NOT NULL CHECK (length(provider_id) >= 1 AND length(provider_id) <= 64),
  vendor_model TEXT NOT NULL CHECK (length(vendor_model) >= 1 AND length(vendor_model) <= 128),
  input_microdollars_per_mtok INTEGER NOT NULL CHECK (typeof(input_microdollars_per_mtok) = 'integer' AND input_microdollars_per_mtok BETWEEN 0 AND 9007199254740991),
  output_microdollars_per_mtok INTEGER NOT NULL CHECK (typeof(output_microdollars_per_mtok) = 'integer' AND output_microdollars_per_mtok BETWEEN 0 AND 9007199254740991),
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 24 AND julianday(updated_at) IS NOT NULL),
  PRIMARY KEY (provider_id, vendor_model)
);