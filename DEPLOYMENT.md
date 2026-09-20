# Deployment Guide

[Back to README](README.md) · [Security](SECURITY.md) · [Runbook](docs/DEPLOYMENT-RUNBOOK.md) · [Rollback](docs/ROLLBACK.md)

Deployment is **human-controlled**. Documentation and CI do not authorize production changes.

## Environments

| Environment | Purpose | Current posture |
| --- | --- | --- |
| `dev` | Local development | Local D1, no remote resources required |
| `staging` | Future pre-production environment | Configuration placeholder |
| `production` | Live Worker | Human-provisioned D1, Workers AI, Vectorize, and secrets |

## Safe deployment sequence

1. Review the intended commit and working tree.
2. Run `npm run check`.
3. Verify Cloudflare resources and bindings.
4. Configure production secrets manually.
5. Apply reviewed D1 migrations.
6. Regenerate Worker types if bindings changed.
7. Run the Wrangler dry-run build.
8. Deploy only after explicit human approval.
9. Register or verify the Telegram webhook.
10. Execute [docs/SMOKE-TESTS.md](docs/SMOKE-TESTS.md).

## Required production resources

Current production architecture expects:

- D1 database,
- Workers AI binding for semantic embeddings,
- Vectorize index for semantic memory,
- Telegram bot credentials,
- credential encryption master secret.

Memory dependencies may degrade independently of ordinary conversation when unavailable.

## Secrets

Set secrets through Wrangler:

```bash
wrangler secret put TELEGRAM_BOT_TOKEN --env production
wrangler secret put TELEGRAM_WEBHOOK_SECRET --env production
wrangler secret put CREDENTIAL_MASTER_SECRET --env production
wrangler secret put OWNER_TELEGRAM_ID --env production
```

Do not place values in `wrangler.toml`, migrations, source code, issue reports, or chat.

## Migrations

Apply reviewed migrations in order using Wrangler's D1 migration system.

Never modify an applied migration as a shortcut for a deployment problem. Add a corrective migration instead.

## Deployment command

```bash
wrangler deploy --env production
```

## Telegram webhook

The deployed endpoint is:

```text
https://<WORKER_HOSTNAME>/telegram/webhook
```

Register it through Telegram's Bot API and verify it with `getWebhookInfo`.

See the complete sequence in [docs/DEPLOYMENT-RUNBOOK.md](docs/DEPLOYMENT-RUNBOOK.md).

## Rollback

If the Worker version itself must be reverted, follow [docs/ROLLBACK.md](docs/ROLLBACK.md).

Remember that code rollback does not automatically undo an already-applied D1 schema migration.
