# HawkTalk Agent

Telegram-first personal AI assistant on Cloudflare serverless infrastructure.
No VPS, no persistent processes.

**Current state: Phase 5 — Memory (durable conversations/messages, unwired).**
The Worker exposes `/healthz` and a secure Telegram webhook (`POST
/telegram/webhook`) backed by D1 (`users`, `processed_updates`). Text messages
get a transport acknowledgement. `src/agent/` holds the provider-independent
core (no provider is wired yet, so there are still no AI replies). Phase 5
adds the durable persistence boundary: `conversations`/`messages` tables
(`migrations/0004_conversations.sql`), an injected D1 repository
(`src/db/conversation-*.ts`) and a validating service
(`src/conversation/service.ts`) — every operation scoped by internal
`users.id`, UUIDv4 ids, deterministic per-conversation sequence, bounded
history (100 msgs / 20k chars / 100k total), one-way archive + cascade delete.
Service timestamps are server-generated through an injectable `Clock`; ordering
uses message `seq`. Unarchive and semantic/long-term memory are deferred.
Not yet exposed via any route; no product behavior changed. Phase 5 awaits human
approval and is uncommitted.

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
4. Remote: `wrangler secret put TELEGRAM_BOT_TOKEN` and
   `wrangler secret put TELEGRAM_WEBHOOK_SECRET` (human only, never automated).
5. Register the webhook:
   `https://api.telegram.org/bot<TOKEN>/setWebhook`
   with `url=https://<worker>/telegram/webhook` and
   `secret_token=<WEBHOOK_SECRET>`.

## Rules

- No commits, pushes, tags, or deploys without explicit human instruction.
- One phase at a time; each phase ends with tests + security review + report.
- The `API-Key` file at the repo root is gitignored and must never be read
  into code, docs, or logs.
