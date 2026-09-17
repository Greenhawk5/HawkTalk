# HawkTalk Agent

Telegram-first personal AI assistant on Cloudflare serverless infrastructure.
No VPS, no persistent processes.

**Current state: Phase 6 — first end-to-end conversational flow (uncommitted).**
The Worker exposes `/healthz` and a secure Telegram webhook (`POST
/telegram/webhook`) backed by D1. Private-chat text messages now run the full
conversational path: idempotency claim → internal user → durable default
conversation → user message persisted → bounded history → Agent Core →
AI Router (sealed credentials, provider failover unchanged) → assistant
message persisted → Telegram reply. Durable per-update processing states
(`migrations/0005_phase6_orchestration.sql`) make generation idempotent: a
Telegram update never triggers two AI generations, and redelivery reuses the
persisted assistant reply. Telegram delivery itself remains at-least-once.
Group/supergroup/channel chats are acknowledged without conversational
processing. Built on the Phase 5 memory boundary (`conversations`/`messages`,
owner-scoped by internal `users.id`, UUIDv4 ids, `seq` ordering, bounded
history, one-way archive) and the provider-independent core in `src/agent/`.
Unarchive and semantic/long-term memory remain deferred.

See `docs/IMPLEMENTATION-ROADMAP.md` (phase plan), `docs/ARCHITECTURE.md`,
and `docs/SECURITY.md`.

## Commands

```bash
npm test            # vitest (Workers pool + local D1)
npm run typecheck   # wrangler types + tsc (app + tests)
npm run lint        # eslint, zero warnings
npm run build       # wrangler dry-run build into dist/
npm run security    # npm audit --audit-level=low
npm run check       # all of the above in order
npm run dev         # wrangler dev --env dev --local
npm run db:migrate:local  # apply migrations/ to local D1
```

Install note: the repo's npm 11.4.2 hits an arborist bug — use
`npx npm@11.19.1 install`. Do not touch the `sharp` override without a
concrete reason (dev-only miniflare transitive dependency, not in the Worker
bundle).

## Telegram setup (manual, Phase 2)

1. Create a bot via BotFather; keep the token secret.
2. Generate a webhook secret (any unguessable 32+ char string).
3. Local dev: copy `.dev.vars.example` to `.dev.vars` (gitignored) and fill in
   `TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET`. Never commit real values.
4. Remote: `wrangler secret put TELEGRAM_BOT_TOKEN`,
   `wrangler secret put TELEGRAM_WEBHOOK_SECRET`, and
   `wrangler secret put CREDENTIAL_MASTER_SECRET` (human only, never
   automated). The conversational flow activates only when the master secret
   is configured; without it the webhook acknowledges in transport-only mode.
5. Register the webhook:
   `https://api.telegram.org/bot<TOKEN>/setWebhook`
   with `url=https://<worker>/telegram/webhook` and
   `secret_token=<WEBHOOK_SECRET>`.

## Rules

- No commits, pushes, tags, or deploys without explicit human instruction.
- One phase at a time; each phase ends with tests + security review + report.
- The `API-Key` file at the repo root is gitignored and must never be read
  into code, docs, or logs.
