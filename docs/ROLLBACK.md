# HawkTalk Rollback Procedure

## Worker rollback

Use Cloudflare's documented rollback mechanism or redeploy a known-good commit after reviewing the target version.

Example:

```bash
wrangler rollback --env production
```

Or:

```bash
git checkout <KNOWN_GOOD_COMMIT>
wrangler deploy --env production
```

Do not assume that a code rollback reverses a D1 schema migration.

## Telegram emergency stop

To stop inbound processing immediately:

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/deleteWebhook"
```

To verify:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

To repoint Telegram to a known-good Worker:

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<KNOWN_GOOD_HOSTNAME>/telegram/webhook",
    "secret_token": "<WEBHOOK_SECRET>"
  }'
```

## Database considerations

D1 migrations are forward application events.

When rolling back application code:

- additive schema changes can remain in place if old code does not reference them,
- destructive or incompatible schema changes require an explicit recovery plan,
- never edit an applied migration file to simulate a rollback.

Before emergency schema changes, preserve evidence and confirm the expected production state.

## Full stop

1. Delete the Telegram webhook.
2. Stop or roll back the Worker deployment as appropriate.
3. Preserve sanitized logs and request IDs.
4. Investigate the failure.
5. Re-register the webhook only after the known-good path is validated.
