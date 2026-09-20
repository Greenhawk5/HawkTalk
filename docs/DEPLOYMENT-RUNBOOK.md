# HawkTalk Deployment Runbook

**Human-only operational document.**

No command in this file should be executed against production automatically.

## 1. Preflight

```bash
node --version
npm --version
npx wrangler --version
npm run check
```

Confirm:

- intended Git commit,
- clean working tree,
- no secrets in staged changes,
- Cloudflare account access,
- Telegram bot ownership,
- production resource IDs.

## 2. Provision Cloudflare resources

Provision the D1 database and Vectorize index manually if not already present.

Vectorize must match the embedding implementation used by HawkTalk. The current semantic-memory architecture is based on `@cf/baai/bge-m3`.

Do not provision unused services simply because they are available.

## 3. Configure production bindings

Update `wrangler.toml` only with reviewed non-secret binding information.

Secrets do not belong there.

## 4. Configure secrets

```bash
wrangler secret put TELEGRAM_BOT_TOKEN --env production
wrangler secret put TELEGRAM_WEBHOOK_SECRET --env production
wrangler secret put CREDENTIAL_MASTER_SECRET --env production
wrangler secret put OWNER_TELEGRAM_ID --env production
```

## 5. Apply migrations

```bash
wrangler d1 migrations apply <DATABASE_NAME> --env production --remote
```

Verify the target database before continuing.

## 6. Generate types and validate

```bash
npm run types
npm run typecheck
npm run lint
npm test
npm run build
npm run security
```

Or:

```bash
npm run check
```

## 7. Provision AI providers

Use the repository provisioning tool described in the architecture documentation.

API keys must never be transmitted through:

- Telegram,
- shell command arguments,
- logs,
- source code,
- issue comments.

The provisioning workflow seals the credential before it reaches D1.

## 8. Commit / push

Human review is required:

```bash
git status
git diff
git add -A
git diff --cached
git commit -m "..."
git push origin main
```

## 9. Deploy

```bash
wrangler deploy --env production
```

Record the deployed hostname.

## 10. Register Telegram webhook

Register:

```text
https://<WORKER_HOSTNAME>/telegram/webhook
```

with Telegram's Bot API and configure the matching secret token.

Then verify the webhook status.

## 11. Run smoke tests

Execute [SMOKE-TESTS.md](SMOKE-TESTS.md).

Do not perform destructive tests against production unless explicitly planned.

## 12. Rollback

Use [ROLLBACK.md](ROLLBACK.md) if the Worker must be reverted or Telegram traffic must be stopped.
