# HawkTalk Deployment Runbook

Human-only deployment procedure for first production release.
No step in this document should be executed by automated tooling.

## Prerequisites

- Cloudflare account with Workers paid or free plan access
- Telegram Bot created via @BotFather (bot token obtained)
- `wrangler` CLI installed and authenticated (`wrangler login`)
- Node.js >=22.13.0 <23
- Git access to this repository

---

## STEP A - Provision Cloudflare Resources

All provisioning is done manually through the Cloudflare Dashboard or `wrangler` CLI.

### A1. Create D1 Database

```bash
wrangler d1 create hawktalk-production
```

Record the `database_id` output. This value goes into `wrangler.toml`.

### A2. Create Vectorize Index

Required for Phase 10 semantic memory. Must match the embedding model exactly.

```bash
wrangler vectorize create hawktalk-memory \
  --dimensions=1024 \
  --metric=cosine
```

- **Index name:** `hawktalk-memory`
- **Dimensions:** 1024 (matches `@cf/baai/bge-m3` in `src/memory/workers-ai-embedding.ts:10`)
- **Metric:** cosine

If Vectorize creation fails due to free-tier unavailability, semantic memory will be disabled gracefully (the code returns null from `buildProductionMemoryService` and memory commands return "Memory is currently unavailable."). Normal conversation continues unaffected.

### A3. Enable Workers AI

Workers AI is available on the free tier. No explicit resource creation needed; the `AI` binding is configured in wrangler.toml and uses the `@cf/baai/bge-m3` model for embeddings. The LLM provider configuration is stored encrypted in D1 via the admin CMS.

### A4. Verify No Unused Resources

The following Cloudflare services are NOT used by current code and should NOT be provisioned:

- Durable Objects
- Queues
- Workflows
- R2

---

## STEP B - Configure Bindings

Update `wrangler.toml` `[env.production]` section with the provisioned resource bindings.

### Required Production Bindings

```toml
[env.production]
name = "hawktalk-agent-production"

[[env.production.d1_databases]]
binding = "DB"
database_name = "hawktalk-production"
database_id = "<D1_DATABASE_ID_FROM_STEP_A1>"
migrations_dir = "migrations"

[env.production.ai]
binding = "AI"

[[env.production.vectorize]]
binding = "VECTORIZE"
index_name = "hawktalk-memory"

[env.production.vars]
APP_ENV = "production"
```

### Binding Summary

| Binding | Type | Purpose | Required | Secret |
|---------|------|---------|----------|--------|
| `DB` | D1 Database | All persistence (conversations, users, providers, memory, admin, usage) | Yes | No |
| `AI` | Workers AI | Embedding generation via `@cf/baai/bge-m3` | Optional (memory degrades gracefully) | No |
| `VECTORIZE` | Vectorize Index | Semantic memory vector storage/search | Optional (memory degrades gracefully) | No |
| `APP_ENV` | Variable | Environment discriminator | Yes | No |

---

## STEP C - Configure Secrets

Secrets are set via `wrangler secret put` and NEVER appear in `wrangler.toml`, source code, or logs.

### Required Secrets

```bash
#### Telegram bot token (from @BotFather)
wrangler secret put TELEGRAM_BOT_TOKEN --env production

#### Webhook verification secret
wrangler secret put TELEGRAM_WEBHOOK_SECRET --env production

#### Master encryption key for AI provider credentials stored in D1
Generate a strong random string (for example, with `openssl rand -hex 32`).
wrangler secret put CREDENTIAL_MASTER_SECRET --env production
```

### Secret Summary

| Secret Name | Purpose | Required | Where Consumed |
|-------------|---------|----------|----------------|
| `TELEGRAM_BOT_TOKEN` | Authenticate outbound Telegram API calls | Yes (for conversational mode) | `src/telegram/webhook.ts`, `src/telegram/client.ts` |
| `TELEGRAM_WEBHOOK_SECRET` | Verify inbound webhook requests from Telegram | Yes (for webhook endpoint) | `src/telegram/webhook.ts:81-90` |
| `CREDENTIAL_MASTER_SECRET` | Decrypt AI provider credentials from D1 store | Yes (for AI routing) | `src/orchestration/production.ts:52-53` |

### Behavior When Secrets Are Missing

- Missing `TELEGRAM_WEBHOOK_SECRET`: webhook returns 500, logs `webhook_misconfigured`
- Missing `TELEGRAM_BOT_TOKEN`: transport-only mode (acknowledgement reply), no AI runs
- Missing `CREDENTIAL_MASTER_SECRET`: `buildProductionProvider` returns null, transport-only mode
- All failures are fail-closed; no secrets are ever leaked in responses or logs

---

## STEP D - Apply D1 Migrations

After the production D1 database is created, apply all migrations:

```bash
wrangler d1 migrations apply hawktalk-production --env production --remote
```

### Migration Order

Migrations are numbered 0001 through 0010+ and must be applied in order. Wrangler's migration system handles ordering automatically based on the filename prefix.

### Migration Contents

| Migration | Schema Area |
|-----------|------------|
| 0001-0006 | Core tables: users, conversations, messages, providers, admission, quotas |
| 0007 | Admin CMS schema |
| 0008 | Admin confirmations ledger |
| 0009 | Usage analytics events |
| 0010 | Semantic memory (embeddings metadata, memory entries) |

### Important Notes

- Migrations use `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` for idempotency
- Re-running migrations on an already-migrated database is safe (no-op)
- Never delete or renumber existing migrations
- Foreign keys and constraints are defined within each migration

---

## STEP E - Generate/Update Worker Types

After configuring bindings, regenerate TypeScript types:

```bash
npm run types
```

This runs `wrangler types --env dev` which generates `worker-configuration.d.ts` matching the bound resources.

Verify type-checking passes:

```bash
npx tsc --noEmit
```

---

## STEP F - Provision AI Providers and Credentials (human)

Provider/credential data lives in D1, encrypted at rest with `CREDENTIAL_MASTER_SECRET` (STEP C). Never send an API key through Telegram chat history or as a command-line argument. Use the committed provisioning CLI, which reads secrets from hidden stdin and seals them with the same AES-GCM `sealCredential` the Worker uses to decrypt:

```bash
# 1. Create a provider (no secrets involved; args are safe):
node --experimental-strip-types scripts/provision.mjs provider openrouter https://openrouter.ai/api/v1 anthropic/claude-sonnet-4 500 --env production

# 2. Add a credential (key + master secret entered at hidden prompts, masked with *):
node --experimental-strip-types scripts/provision.mjs credential openrouter "primary key" 100 --env production
#    - when prompted, paste the API key (input is hidden), then Enter
#    - enter CREDENTIAL_MASTER_SECRET (or export HAWKTALK_CREDENTIAL_MASTER_SECRET first)

# 3. Repeat step 2 to add more keys to the same provider (rotation/quota distribution).
```

Notes:
- Default (non-`--execute`) mode prints a `wrangler d1 execute` command containing ciphertext only; run it yourself, or pass `--execute` to let the script run wrangler (nothing enters your shell history).
- The plaintext key is never logged, stored, audited, or sent through Telegram; only the versioned `v1.<salt>.<iv>.<ciphertext>` envelope reaches D1.
- Rotation: add a new credential, disable the old one in the Admin CMS (`/admin`), then delete it as OWNER.
- Verify: `npx wrangler d1 execute DB --env production --remote --command "SELECT id, label, weight, enabled FROM provider_credentials;"` (metadata only; ciphertext is never displayed by the Admin CMS).
## STEP G - Human Git Commit/Push

```bash
git add -A
git status          # Review staged changes carefully
git diff --cached   # Verify no secrets are included
git commit -m "chore: prepare for production deployment"
git push origin main
```

**CRITICAL:** Before pushing, verify that no secret values appear in any committed file. Check `.dev.vars` is gitignored. Review `git diff --cached` output line by line.

---

## STEP H - Human Deploy

```bash
wrangler deploy --env production
```

Record the deployed Worker URL from the output. This is needed for Step H.

The production Worker URL format is:
`https://hawktalk-agent-production.<YOUR_SUBDOMAIN>.workers.dev`

Or if using a custom domain, configure it in the Cloudflare Dashboard after deployment.

---

## STEP I - Human Register Telegram Webhook

After the Worker is deployed and accessible at its production URL, register the webhook with Telegram.

### Webhook URL Format

```
https://<WORKER_HOSTNAME>/telegram/webhook
```

### Registration Command

Replace `<BOT_TOKEN>` with your actual Telegram bot token and `<WEBHOOK_URL>` with the full production URL. Replace `<WEBHOOK_SECRET>` with the exact value you set in Step C.

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "<WEBHOOK_URL>",
    "secret_token": "<WEBHOOK_SECRET>",
    "allowed_updates": ["message", "callback_query"],
    "max_connections": 40
  }'
```

### Verification

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

Expected response includes `"url": "<WEBHOOK_URL>"` and `"has_custom_certificate": false`.

### To Disable Webhook (Rollback)

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/deleteWebhook"
```

---

## STEP J - Production Smoke Tests

Execute the checklist in [docs/SMOKE-TESTS.md](./SMOKE-TESTS.md) immediately after webhook registration.

---

## STEP K - Rollback Procedure

See [docs/ROLLBACK.md](./ROLLBACK.md) for the complete rollback process.

---

## Free-Tier Compliance Notes

- **Embeddings:** Uses Cloudflare Workers AI `@cf/baai/bge-m3` (free tier). No paid embedding provider required.
- **LLM Providers:** Configured via admin CMS, credentials encrypted in D1. The system supports any provider but does not mandate a paid one. If Workers AI free quota is exhausted, memory features degrade gracefully.
- **Semantic Memory Failure Mode:** When AI or Vectorize bindings are absent, or Workers AI quota is exhausted, `buildProductionMemoryService()` returns null. Memory commands (`/remember`, `/memories`, `/forget`) return "Memory is currently unavailable." Normal conversation proceeds without memory recall. There is NO automatic fallback to a paid embedding provider.
- **Vectorize:** Free tier includes limited vectors. Monitor usage via the Cloudflare dashboard.

---

## Observability

Production diagnostics use structured JSON logging with request correlation:

- Every request gets a unique `X-Request-ID` header (UUID v4, generated in `src/index.ts:6`)
- All log entries include `{ event, request_id }` â€” no user content, tokens, or secrets
- Log event categories: `webhook_*`, `request_failed`, `provider_*`, `memory_*`, `admin_*`
- Usage tracking: one `usage_events` row per successful AI generation (idempotent by request ID)
- Error responses are always generic ("Something went wrong") â€” internal details stay in logs only
- Security headers on every response: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'`, `Referrer-Policy: no-referrer`

Monitor via Cloudflare Workers logs dashboard or `wrangler tail --env production`.
