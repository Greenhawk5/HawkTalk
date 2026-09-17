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
  telegram/           IMPLEMENTED (Phase 2 transport + Phase 6 flow entry):
                      webhook.ts (auth + validation + idempotency + private-chat
                      conversational dispatch + durable redelivery reuse),
                      client.ts (sendMessage, bounded retry), parser.ts
                      (incl. chatType), types.ts, ack.ts (transport-only reply)
  orchestration/      IMPLEMENTED (Phase 6, thin application layer):
                      service.ts (conversational use-case + durable idempotency
                      ordering), types.ts (ports), conversation-orchestrator.ts
                      (default conversation resolution), processing-d1.ts
                      (durable update state machine), production.ts (AI Router
                      composition). Coordinates components; owns no parsing,
                      provider selection, or Telegram retry policy.
  db/                 IMPLEMENTED (Phase 2 + 4 + 5 + 6): telegram.ts — user upsert +
                      atomic update_id claim helpers; users.ts — internal user
                      lookup; providers.ts — provider/credential row reads;
                      conversation-repository.ts (port), conversation-d1.ts
                      (D1 adapter), conversation-types.ts — durable
                      conversations/messages, every statement scoped by
                      internal users.id, detached plain row objects
  conversation/       IMPLEMENTED (Phase 5, persistence boundary service):
                      service.ts — validation + bounds orchestration over the
                      injected repository (UUIDv4 ids, roles, 20k/100k/100
                      history caps, archive/delete). No Telegram/D1/network in
                      the service contract; repository is injected.
  security/           webhook auth, RBAC, rate limiting, isolation checks
  agent/              IMPLEMENTED (Phase 3, core only, no I/O): types.ts
                      (AgentRequest/Message/Config/Response + bounds),
                      provider.ts (ModelProvider port), errors.ts (AgentError /
                      ProviderError), engine.ts (validate → normalize →
                      provider → normalize). No Telegram/D1/network/credentials.
  ai/                 IMPLEMENTED (Phase 4): credential sealing + AI Router
                      implementing the ModelProvider port
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

## AI provider abstraction (Phase 3 port; router lands in Phase 4)

```ts
interface ModelProvider {
  readonly id: string;
  generate(input: ProviderGenerateInput): Promise<ProviderGenerateResult>;
}
```

`ProviderGenerateInput` carries only `{ requestId, model, systemPrompt,
messages, maxOutputTokens, temperature?, signal? }` — no credentials, no
transport types. The Phase 4 AI Router implements this interface; concrete
providers (OpenRouter, Z.AI, OpenAI-compatible) sit behind it, each owning its
own key management. The Agent Core only ever sees the port. Keys are never in
D1 plaintext; all external representations are masked (e.g. `sk-…9a31`).

## Data model (per-phase, never all at once)

Phase 2: `users`, `processed_updates` (idempotency)
Phase 3: no new tables (context is caller-supplied; persistence deferred to Phase 5)
Phase 4: `providers`, `provider_credentials`
Phase 5: `conversations`, `messages` (durable history, user-scoped; semantic memory deferred to Phase 10)
Phase 6: `processed_updates` extended with durable processing states
(`processing_state`, `conversation_id`, `assistant_message_id`) +
`default_conversations` (per-user default mapping)
Phase 7: `roles/quotas/usage/rate_limits`
Phase 8: `agent_settings`, `prompt_versions`, `feature_flags`, `audit_logs`
Phase 9: `tasks`

Migrations in `/migrations`, applied via `wrangler d1 migrations apply`.

## Request flow (Phase 6 end-to-end)

```
Telegram webhook → secret check (constant-time) → parse update (incl. chatType)
  → atomic update_id claim (duplicate → durable-reuse path, never regenerate)
  → unsupported / non-private chats: acknowledge, stop
  → upsert Telegram user → resolve internal users.id
  → conversational flow (src/orchestration):
      resolve/create default conversation (owner-scoped, atomic)
      → durable markGenerating (claimed → generating; the regeneration gate)
      → persist user message
      → load bounded history (≤20 msgs, service caps)
      → Agent Core (validate → provider port)
      → AI Router (provider/credential selection, failover unchanged)
      → persist assistant message
      → durable completed (assistant_message_id)
  → send Telegram reply (bounded client retry)
```

Failure map: pre-generation failures (conversation resolution) release the
claim — redelivery reprocesses from scratch, no AI ran. After markGenerating
succeeds, the update NEVER regenerates: AI failure → terminal `failed`
(redelivery acknowledges); success → assistant persisted then `completed`;
a crash between persist and complete stays `generating` — redelivery reuses
the persisted assistant message for delivery. Telegram sendMessage is
at-least-once externally: a timed-out send that reached Telegram can deliver
twice; generation and persistence remain idempotent per update_id.

## Persistence boundary (Phase 5)

Durable conversations/messages live behind small injected interfaces; nothing
outside `src/db/conversation-*.ts` touches their tables, and the Agent Core
has no D1 access (context is supplied by the application layer):

```
ConversationService (src/conversation/service.ts)
  validates + bounds every argument (UUIDv4 ids, roles, title/content sizes,
  list/history limits), then calls:
ConversationRepository (src/db/conversation-repository.ts, port)
  implemented by D1ConversationRepository (src/db/conversation-d1.ts):
  prepared statements only, every query scoped by internal users.id,
  atomic single-statement append (INSERT ... SELECT last_seq + 1 ... RETURNING
  guarded by a trigger enforcing ownership + active status + exact next seq,
  UNIQUE(conversation_id, seq) as backup), history read as the newest
  contiguous suffix by seq.
```

- Ownership: `users.id` is the only ownership key; a row not owned by the
  caller is indistinguishable from a missing row on every operation.
- Message content is opaque, faithful, arbitrary text (secrets included) —
  no scanning, redaction, or heuristics anywhere in the boundary.
- Message `id`s are generated server-side via `crypto.randomUUID()` and
  validated (regex + `length = 36` CHECK); no caller-supplied ids.
- No metadata/structured-field columns: unsupported fields are rejected
  outright so arbitrary payload baggage (e.g. credentials) cannot be stored.
- Service timestamps come from an injected `Clock`, defaulting to server/runtime
  `RuntimeClock`; public operations accept no caller timestamps. Tests can inject
  a deterministic clock. Append, rename, and archive preserve nondecreasing
  timestamps; message ordering uses `seq`, not wall-clock time. Message deletion
  touches the conversation using the database runtime clock.
- Archive is one-way in Phase 5 (`active` → `archived`): the repository exposes
  dedicated rename/archive operations, not generic status mutation. Archived
  conversations reject appends but remain readable, renameable, and deletable.
  Unarchive is deferred. Delete cascades to messages via FK; no retention jobs.
- Semantic and long-term memory remain deferred; this boundary only prepares
  bounded provider-neutral history/context.

Every step is wrapped in one correlation/request ID; failures produce safe user-facing errors and sanitized internal logs.

## Environments

- **local dev:** `wrangler dev --env dev` + local D1 (`migrations/`, applied via `npm run db:migrate:local`) + `.dev.vars` (gitignored)
- **staging/production:** defined in `wrangler.toml` with **no bindings** — they fail closed until a human provisions D1 and secrets, then run `wrangler types`
- Production secrets via `wrangler secret put`; runtime config via D1 (admin-managed, later phases)

Commands: `npm run check` runs typecheck → lint → tests → dry-run build → audit in one pass. Install note: repo npm 11.4.2 has an arborist bug — `npx npm@11.19.1 install`.

See `docs/SECURITY.md` for threat model and controls.
