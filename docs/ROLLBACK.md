# HawkTalk Rollback Procedure

## Worker Deployment Rollback

To revert to a previous Worker deployment:

```bash
wrangler rollback --env production
```

Or redeploy a known-good commit:

```bash
git checkout <KNOWN_GOOD_COMMIT>
wrangler deploy --env production
```

Cloudflare Workers automatically maintains the previous deployment version. `wrangler rollback` restores it immediately with near-zero downtime.

## Telegram Webhook Disable/Repoint

### Disable webhook entirely (stops all message processing)

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/deleteWebhook"
```

### Repoint to a different URL (e.g., staging or previous worker)

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "<NEW_WORKER_URL>/telegram/webhook",
    "secret_token": "<WEBHOOK_SECRET>"
  }'
```

### Verify current webhook status

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

## Database Migration Warning

D1 migrations are NOT reversible through wrangler. Once applied, migration state is tracked in the `d1_migrations` table and will not re-run. Rolling back code that depends on a new schema column/table while leaving the migration applied is safe (the extra columns/tables simply go unused). However, rolling back code after a migration has modified or dropped columns may cause runtime errors.

### If deployment is reverted but migration already applied

- Extra tables/columns from the forward migration remain in the database. This is harmless.
- The rolled-back code will not reference the new schema elements.
- If the forward migration renamed or dropped columns (none currently do), manual D1 SQL intervention would be required via `wrangler d1 execute`.
- Current migrations (0001-0010) are purely additive (CREATE TABLE, ALTER TABLE ADD COLUMN). No destructive schema changes exist. Rollback is always safe with these migrations.

## Emergency Full Stop

If something is critically wrong and you need to halt all processing immediately:

1. Delete the Telegram webhook (stops inbound traffic)
2. Optionally set a maintenance secret to invalidate webhook auth
3. Roll back the Worker deployment
4. Re-register the webhook once the correct version is deployed