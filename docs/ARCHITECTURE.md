# HawkTalk Agent — Architecture

Telegram-first personal AI assistant running entirely on Cloudflare serverless infrastructure. No VPS, no persistent processes, no Docker.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Cloudflare Workers (TypeScript) | Required: serverless, edge, no server |
| Relational data | D1 | users/conversations/messages/memories/config — relational, free tier, native |
| Coordination | Durable Objects (only if justified) | per-user session locking / idempotency if needed; not used by default |
| Scheduled work | Workflows or cron triggers (Phase 9) | durable, retryable reminders without a server |
| Objects | R2 (only if needed) | future attachments |
| Testing | Vitest + miniflare (`@cloudflare/vitest-pool-workers`) | native Workers test environment |

Other Cloudflare products (Queues, Vectorize, AI Gateway) are **not** adopted by default; each gets added only when a phase justifies it.

## Module boundaries

```
src/
  index.ts            Worker entry: fetch handler → router
  router/             request routing, request IDs, error envelope
  telegram/           IMPLEMENTED (Phase 2, transport only): webhook.ts (auth +
                      validation + idempotency + placeholder reply), client.ts
                      (sendMessage, bounded retry), parser.ts, types.ts
  db/                 IMPLEMENTED (Phase 2): telegram.ts — user upsert +
                      atomic update_id claim helpers (prepared statements only)
  security/           webhook auth, RBAC, rate limiting, isolation checks
  agent/              agent core: context construction, execution budget
  ai/                 AIProvider interface + router + concrete providers
  memory/             short/long/semantic memory engines
  tools/              tool registry + individual tools
  quota/              quotas, usage tracking
  tasks/              reminders/workflows (Phase 9)
  admin/              admin CMS (Phase 8)
```

Rules:
- `telegram/` knows nothing about AI. `ai/` knows nothing about Telegram. The agent core composes them.
- External content (web fetch/search results) is always passed to the model inside explicit untrusted delimiters and never merged into system instructions.
- All DB access goes through `db/` helpers that enforce user scoping — no raw ad-hoc queries in handlers.

## AI provider abstraction

```ts
interface AIProvider {
  readonly id: string;
  chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResult>;
}
```

Concrete providers (OpenRouter, Z.AI, OpenAI-compatible) implement this interface. The **AI Router** wraps a set of configured provider instances + API keys and decides which to try: round-robin / weighted / health-aware, with cooldown on 429 and bounded failover. Agent core only ever sees the router. Keys are stored in Cloudflare secrets/config, never in D1 plaintext; all external representations are masked (e.g. `sk-…9a31`).

## Data model (per-phase, never all at once)

Phase 2: `users`, `processed_updates` (idempotency)
Phase 3: `conversations`, `messages`
Phase 4: `providers`, `provider_keys`, `provider_models`, `provider_health`
Phase 5: `memories`
Phase 7: `roles/quotas/usage/rate_limits`
Phase 8: `agent_settings`, `prompt_versions`, `feature_flags`, `audit_logs`
Phase 9: `tasks`

Migrations in `/migrations`, applied via `wrangler d1 migrations apply`.

## Request flow

```
Telegram webhook → secret check → parse update → dedupe (update_id)
  → upsert user → RBAC/quota/rate-limit gates
  → agent core: build context (system prompt + history + memory)
  → AI router → provider → reply
  → persist message → send via Telegram client
```

Every step is wrapped in one correlation/request ID; failures produce safe user-facing errors and sanitized internal logs.

## Environments

- **local dev:** `wrangler dev --env dev` + local D1 (`migrations/`, applied via `npm run db:migrate:local`) + `.dev.vars` (gitignored)
- **staging/production:** defined in `wrangler.toml` with **no bindings** — they fail closed until a human provisions D1 and secrets, then run `wrangler types`
- Production secrets via `wrangler secret put`; runtime config via D1 (admin-managed, later phases)

Commands: `npm run check` runs typecheck → lint → tests → dry-run build → audit in one pass. Install note: repo npm 11.4.2 has an arborist bug — `npx npm@11.19.1 install`.

See `docs/SECURITY.md` for threat model and controls.
