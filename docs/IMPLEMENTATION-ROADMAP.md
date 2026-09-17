# HawkTalk Agent — Implementation Roadmap

Source of truth for the phase-by-phase build. Update after every change of status.

Status legend: `[ ]` Not started · `[-]` In progress · `[x]` Completed · `[!]` Blocked

---

## Current repository state (audited 2026-09-17, updated after Phase 6)

- Git repo on `main`, baseline `c5c9844` (Phase 5 accepted) + uncommitted Phase 6 implementation (uncommitted by policy).
- Phase 1 foundation (Worker, `/healthz`, D1, Vitest pool, ESLint, strict TS) intact and green.
- Phase 2 implemented: Telegram transport (`src/telegram/`, `src/db/telegram.ts`, `migrations/0002_telegram.sql`, webhook route).
- Phase 4 implemented: AI router layer (`src/ai/`, `src/db/providers.ts`, `migrations/0003_ai_providers.sql`).
- Phase 5 implemented and accepted: durable conversations/messages (`src/conversation/`, `src/db/conversation-*.ts`, `migrations/0004_conversations.sql`).
- Phase 6 implemented (awaiting approval): application orchestration + first end-to-end conversational flow (`src/orchestration/`, `migrations/0005_phase6_orchestration.sql`): private-chat text messages run claim → internal user → default conversation → persist user message → bounded history → Agent Core → AI Router → persist assistant reply → Telegram reply, with durable per-update idempotency.
- `API-Key` remains untracked + gitignored — never read, never exposed.
- Toolchain: Node v22.17.0, Wrangler 4.133.0, `npm run check` green.
- Constraint: Windows 11 host; PowerShell tooling.

## Global rules

- No commit / push / deploy / release without explicit human instruction.
- One phase at a time; stop after each and wait for approval.
- Every phase: tests + typecheck + lint + build + security review + doc/roadmap update + completion report.
- Secrets never in source, logs, docs, or D1. Use `wrangler secret put` / `.dev.vars` (gitignored).

---

## PHASE 0 — Repository Audit & Architecture

**Objective:** Understand the repo, define architecture, conventions, and roadmap. No product code.

- [x] Inspect repository, files, package.json, git state
- [x] Verify toolchain (Node 22, Wrangler 4)
- [x] Create `docs/IMPLEMENTATION-ROADMAP.md`
- [x] Create `docs/ARCHITECTURE.md`
- [x] Create `docs/SECURITY.md`
- [x] Define Phase 1–10 plan (below)

**Deliverables:** 3 docs. **Status: COMPLETE**

---

## PHASE 1 — Cloudflare Foundation

**Objective:** Working Worker + project skeleton + D1 + test/typecheck/lint toolchain.

Tasks:
- [x] `wrangler.toml` (worker, D1 binding, environments: dev local-only; staging/production fail-closed with no bindings)
- [x] TypeScript config, project structure (`src/`, `tests/`, `migrations/`)
- [x] Worker entry: request router skeleton, request-ID, safe error handling
- [x] `/healthz` endpoint (GET/HEAD only, 404/405 elsewhere)
- [x] D1 migration runner + initial no-op migration (no product tables)
- [x] Vitest 4 + `@cloudflare/vitest-pool-workers` test infra; ESLint flat config; `npm run check` aggregate
- [x] `.dev.vars.example`

Test results: 29 tests passing (router units, HTTP integration incl. HEAD/405/404, security headers, untrusted request-ID rejection, fail-closed missing-binding, no secret in logs, D1 migration idempotency + isolation).
Security checks: `npm audit` clean (sharp override 0.35.4); `API-Key`, `.dev.vars*`, `.env*`, `.wrangler/`, `dist/`, `worker-configuration.d.ts` verified gitignored; no CORS; user-facing errors generic; logs carry no error payloads.
Environment notes: repo npm (11.4.2) hit an arborist bug installing the toolchain — use `npx npm@11.19.1 install` (documented in README); ESLint pinned to 10.x, vitest to 4.1.x per `@cloudflare/vitest-pool-workers` 0.22.0 peers.
Manual actions: none (local only; no deploy).
**Acceptance:** MET — `npm run check` green; `wrangler dev` serves `/healthz` (200) and returns 404/405 correctly.

**Status: COMPLETE**

---

## PHASE 2 — Telegram Integration

**Objective:** Secure webhook receiving Telegram updates, user identification.

Tasks:
- [x] Telegram client abstraction (`src/telegram/client.ts`: sendMessage only, bounded retry)
- [x] Webhook endpoint `POST /telegram/webhook` with secret-token verification (constant-time compare)
- [x] Update parsing/validation (`src/telegram/parser.ts`: text vs unsupported vs invalid)
- [x] `users` + `processed_updates` tables (`migrations/0002_telegram.sql`) + upsert on first contact
- [x] Idempotency: atomic `INSERT ... ON CONFLICT DO NOTHING` claim on `update_id` PK (no SELECT-then-INSERT)
- [x] Safe placeholder reply (`TRANSPORT_ACK_TEXT` — no fake AI); Telegram API failure handling with claim release + 500

Tests: 54 webhook/client tests (auth, HTTP, validation, identity, idempotency incl. 5-way concurrent duplicates, API failure matrix, secret-leak scans) + 7 database tests (migration replay, uniqueness) + 24 Phase 1 tests intact. Total 85/85 green.
Security: webhook secret + bot token via env only; generic error bodies; logs carry only `{event, request_id}` (test-enforced key set); numeric-ID identity; prepared statements; no retry on responses (network/timeout only, max 2 attempts).
Deviations: none from the Phase 2 plan. `route()` became async (webhook needs env + D1); Phase 1 tests updated for `await` only.
Known limitations: no rate limiting yet (Phase 7); `processed_updates` grows one row per unique update (cleanup deferred); unsupported updates acknowledged without user creation.
Manual actions: create bot via BotFather, set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_WEBHOOK_SECRET` via `.dev.vars` (local) / `wrangler secret put` (remote), register webhook at `POST https://<worker>/telegram/webhook` (local dev via ngrok/dev-mode optional). See README.
**Acceptance:** MET — transport proves end-to-end (mocked Bot API); placeholder reply sent exactly once per update.

**Status: COMPLETE**

---

## PHASE 3 — Agent Core

**Objective:** Provider-independent, transport-independent Agent Core boundary
(interfaces + orchestration only). NOTE: this supersedes the earlier draft plan
below — per explicit approval, Phase 3 implements NO real provider, NO API
keys, NO D1 conversation persistence, and NO Telegram wiring.

Tasks:
- [x] `AgentRequest` / `AgentMessage` (system/user/assistant) / `AgentConfig` / `AgentResponse` types (`src/agent/types.ts`)
- [x] `ModelProvider` port: `generate(input)` → provider-neutral result; credentials never cross it (`src/agent/provider.ts`)
- [x] Stable error model: `AgentError` codes (invalid_request, provider_unavailable/timeout/failure/malformed, internal); `ProviderError` mapped, never propagated (`src/agent/errors.ts`)
- [x] Engine: validate → normalize context (system prompt first, order preserved, empties dropped) → provider with timeout race → normalize result (`src/agent/engine.ts`)
- [x] Bounds in one place (message/context/output/metadata/timeout caps); no logs, no I/O, no global state in core

Tests: 53 agent unit tests (validation incl. prototype-pollution, normalization, fake-provider matrix, timeout race, no-network stub, isolation) + all Phase 1/2 suites intact. Total 138/138 green.
Security: every field validated as untrusted; generic error messages only; no message/prompt logging (core emits zero logs); provider output length-capped; raw throwables mapped to internal.
Deviations: none from the approved scope. Deliberately NOT built: concrete providers, AI Router, retries/health (Phase 4), D1 `conversations`/`messages` tables (not strictly necessary — context is caller-supplied; state stays behind the future Phase 5 boundary), Telegram adapter/wiring (interfaces only).
Manual actions: none.
**Acceptance:** MET — core runs fully offline against injected fakes with stable errors.

**Status: COMPLETE**

---

## PHASE 4 — AI Router

**Objective:** Multi-provider, multi-key routing with health/failover.

Tasks:
- [ ] `providers`, `provider_keys` (secret-hashed storage design), `provider_models` tables
- [ ] Round-robin, weighted routing
- [ ] Health tracking: ACTIVE/COOLDOWN/UNHEALTHY/DISABLED
- [ ] Error classification (401/403/429/5xx/timeout/network)
- [ ] Cooldown + failover chain + bounded retry policy
- [ ] Masked key representation (never full secret outside storage)

Tests: routing order, cooldown on 429, failover across providers, all-providers-down, key masked in all outputs. Heavily mocked providers.
**Acceptance:** configured with 2+ mock providers; failure of one transparently falls over.

---

## PHASE 5 — Memory

**Objective:** Durable conversations and messages, user-scoped at the data-access layer. NOTE: the original draft plan (semantic memory, `memories` table, context injection) was superseded by explicit approval — Phase 5 implements durable conversations/messages only, with the semantic-memory placeholder deferred to Phase 10.

Tasks:
- [x] `conversations` + `messages` tables (`migrations/0004_conversations.sql`), scoped by internal `users.id` (never Telegram ID)
- [x] UUIDv4 conversation/message IDs (`crypto.randomUUID()`, validated by regex + DB CHECK length = 36)
- [x] Deterministic concurrency-safe per-conversation sequence: single-statement atomic `INSERT ... SELECT last_seq + 1 ... RETURNING` guarded by a `BEFORE INSERT` trigger (ownership + active status + exact next-seq), `UNIQUE(conversation_id, seq)` as backup
- [x] Transactional appends: one atomic statement advances `last_seq`, inserts the message, and stamps the conversation timestamp (trigger-maintained)
- [x] Bounded history/context in `src/conversation/service.ts`: newest contiguous suffix, ≤100 messages, ≤20k chars per message, ≤100k chars total; system prompt policy stays in AgentCore config (8k), not persisted
- [x] Server-generated service timestamps through injected `Clock` (runtime default, deterministic test clock); public callers cannot supply timestamps; message ordering uses `seq`
- [x] One-way archive (`active` → `archived`) through a dedicated repository API; no generic status mutation or unarchive; archived conversations reject appends and allow cascade deletion via FK `ON DELETE CASCADE`; no retention jobs
- [x] Roles system/user/assistant only, enforced by CHECK constraint
- [x] No metadata column: unsupported structured fields rejected (no arbitrary baggage)
- [x] Small injected repository/service interfaces (`src/db/conversation-repository.ts`, `src/db/conversation-d1.ts`, `src/conversation/service.ts`); plain detached row objects; no D1 in AgentCore
- [x] Every operation scoped by authenticated application user id + conversation id, enforced in every SQL statement

Tests: 33 Phase 5 tests covering schema constraints, ownership/isolation, invalid input, injected/runtime clocks, rejected timestamp overrides, timestamp consistency, concurrency sequence allocation, bounded history/context, one-way archive and cascade deletion, content faithfulness, metadata rejection, and no-log behavior. Migration replay/idempotency is covered separately in the database suite. Acceptance requires a fresh complete verification run; prior green counts are not approval.
Security: prepared statements only; ownership scoped per statement; no content heuristics/scanning/redaction (opaque faithful text); no content in logs; no metadata columns to carry credentials.
Implementation notes: ownership consistency uses a composite foreign key and owner-scoped statements; atomic append plus triggers enforce exact next-sequence allocation, with a UNIQUE constraint as backup and no retry loop. Vitest disables Wrangler dotenv loading through explicit environment settings and `envFiles`; other Wrangler commands must also explicitly disable secret auto-loading when verifying.
Known limitations: no transport wiring, semantic/long-term memory, retention jobs, or unarchive. Sequence allocation is gapless for appends; explicit message deletion leaves historical gaps without reusing sequence numbers. Concurrent writers are ordered by database serialization, not invocation order. Deletion timestamp touches use the database runtime clock rather than the service's injected clock.
Manual actions: approval, Git operations, and deployment remain human-controlled.
**Acceptance:** Pending human approval after complete verification.

**Status: WAITING FOR HUMAN APPROVAL**

---

## PHASE 5 — Memory

**Status: COMPLETE** (accepted at `c5c9844`)

---

## PHASE 6 — Application Orchestration & First Conversational Flow

**Objective:** Thin application/orchestration layer connecting Telegram transport, durable conversation memory, Agent Core, and the AI Router into the first complete conversational path. Private-chat text messages only. No tools, no web search, no quotas, no semantic memory.

Tasks:
- [x] Migration `0005_phase6_orchestration.sql`: extends `processed_updates` with durable processing states (`processing_state`, `conversation_id`, `assistant_message_id`) + `default_conversations` table (per-user default mapping)
- [x] Durable idempotency state machine: `claimed → generating → completed | failed`; atomic transition prevents duplicate AI generation on redelivery
- [x] Default conversation resolution: owner-scoped `default_conversations` mapping; creates/replaces atomically when missing or archived/deleted; never trusts Telegram chat IDs
- [x] Private-chat-only processing: parser emits `chatType`; non-private chats acknowledged without user upsert, conversation resolution, history, AI, or persistence
- [x] Orchestrator ports (`src/orchestration/types.ts`): `ProcessingRepository`, `ConversationOrchestrator`
- [x] D1 implementations: `D1ProcessingRepository`, `D1ConversationOrchestrator`
- [x] Conversational use-case (`src/orchestration/service.ts`): resolve conversation → markGenerating → persist user message → bounded history → Agent Core → AI Router → persist assistant → completed
- [x] Redelivery reuse: `getCompletedAssistantText()` returns persisted reply for completed updates without calling AI
- [x] Pre-generation failure handling: `conversation_failed` releases claim for clean redelivery; post-`markGenerating` failures are terminal (never regenerate)
- [x] Production composition (`src/orchestration/production.ts`, `src/router/index.ts`): wires D1 + AI Router when `CREDENTIAL_MASTER_SECRET` is configured; falls back to transport-only mode otherwise
- [x] Webhook integration: flow mode dispatches private chats through orchestration; transport-only mode preserves Phase 2 acknowledgement semantics
- [x] `src/db/users.ts`: internal user lookup by Telegram ID
- [x] `getMessage` added to `ConversationRepository` port for single-message retrieval

Tests: 27 new tests covering default conversation lifecycle, concurrent resolution, end-to-end flow, history bounds, durable idempotency (concurrent delivery, AI failure terminal, redelivery reuse), router integration with sealed credentials, processing state transitions, private-chat-only enforcement, group chat rejection, pre-generation claim release, post-generation claim retention, foreign update isolation, and secret non-leakage. All prior suites intact. Total 252/252 green.
Security: prepared statements only; ownership scoped per statement; no content logged; no credentials cross orchestration boundary; generic errors to users; constant-time webhook auth preserved; at-least-once Telegram delivery documented as unavoidable limitation.
Known limitations: Telegram sendMessage is at-least-once externally (a timed-out send that reached Telegram may deliver twice even though generation/persistence are idempotent). Router-level failover within one invocation remains unchanged (one application call may try multiple providers). No exactly-once provider billing guarantee. No conversation-selection UI. No tools, web search, quotas, rate limiting, admin CMS, semantic memory, embeddings, reminders, or billing. Deletion timestamp touches use the database runtime clock rather than the service's injected clock. Sequence gaps from message deletion are not reused.
Manual actions: approval, Git operations, deployment, and `wrangler secret put CREDENTIAL_MASTER_SECRET` remain human-controlled.
**Acceptance:** Pending human approval after complete verification.

**Status: WAITING FOR HUMAN APPROVAL**

---

## PHASE 7 — Tools & Web

**Objective:** Tool registry + web_search + web_fetch with strong SSRF/injection defense.

Tasks:
- [x] Tool registry (`src/tools/registry.ts`): name validation, schema, deterministic lookup, bounded execution with per-tool timeout (15s) and result truncation (10k chars)
- [x] Structured tool-call protocol (`src/tools/parser.ts`): `<tool_call>{"name":"...","input":{...}}</tool_call>` format; strict JSON parsing; rejects malformed/unknown/non-object inputs
- [x] `web_search` tool (`src/tools/web-search.ts`): provider-independent `SearchProvider` interface; normalized `{title, url, snippet}` results; query/limit validation; fake provider in tests
- [x] `web_fetch` tool (`src/tools/web-fetch.ts`): provider-independent `FetchProvider` interface; HTTPS-only; SSRF blocking (IPv4/IPv6 private/loopback/link-local); HTML sanitization; 50k char extraction cap; content-type restriction
- [x] SSRF protection (`src/tools/ssrf.ts`): blocks localhost, loopback, private IPv4 ranges, IPv6 loopback/link-local/unique-local/multicast, metadata endpoints; handles bracketed IPv6 from URL constructor
- [x] Prompt-injection defense: all tool results wrapped in `<untrusted_tool_result>` delimiters before being passed back to the model
- [x] Agent loop (`src/tools/agent-loop.ts`): application-layer loop using existing `runAgent()` unchanged; max 5 iterations, max 10 total tool calls; unknown tools rejected by registry; final response extracted after loop exhaustion

Tests: 56 new tests covering registry CRUD, parser validation/rejection, SSRF matrix (IPv4/IPv6/localhost/metadata/redirects), web search normalization/limits/failures, web fetch HTTPS enforcement/SSRF blocking/content-type/size limits/sanitization, prompt injection wrapping, secret non-leakage, agent loop bounds/integration/registry enforcement. All prior suites intact. Total 308/308 green.
**Acceptance:** MET — tool architecture established; web_search and web_fetch implemented with SSRF protection; bounded agent loop verified; security test suite passes.

---

## PHASE 8 — Quotas & Abuse Protection

**Objective:** Roles, quotas, rate limits, usage tracking. Admin CMS is the subsequent
phase (next section) — not part of Phase 8.

Tasks:
- [x] RBAC: OWNER/ADMIN/VIP/USER/BLOCKED as durable server-side user roles
      (`users.role` CHECK-enforced; defaults to USER on upsert; never client-settable)
- [x] Quota engine: role-keyed `admission_policies` (configurable daily_messages);
      durable per-update usage ledger (`request_admissions`) with quota_units accounting
- [x] Rate limits (per-second, hourly burst) separate from quotas; independent
      bypass flags per policy; fixed UTC-aligned windows
- [x] Blocked user handling (BLOCKED role + non-active status both fail closed);
      admin/OWNER quota bypass policy via `bypass_quota`/`bypass_rate`
- [x] Atomic admission gate: single-statement `INSERT … SELECT` keyed by update_id
      PRIMARY KEY + D1 batch; enforced in orchestration before conversation work
- [x] Application-layer deterministic rejection texts (no AI invocation for rejections)

Tests: 13 admission-engine tests (boundary, concurrency serialization, duplicate-update
single-charge, midnight reset, per-second/hour windows, user isolation, role policies,
inactive-user fail-closed, admin bypass with retained rate protection) + 6 webhook
admission tests (no AI/no rows/claim retention on rejection, unavailable→500+claim
release, redelivery no-double-charge, transport-only no admission writes). All prior
suites intact. Total 327/327 green.
Security: roles and policies live only in D1 server-side; Telegram identity never
carries authorization; admission ledger keyed by update_id prevents double-charge on
redelivery; rejections emit fixed application-layer texts (no counters/infrastructure
details); ledger indices bounded (per-user time index); no new secrets.
Known limitations: per-isolate clock (Worker runtime) drives window boundaries —
globally consistent time is not guaranteed across isolates; quota counts messages
admitted (failed AI generation still consumes quota by design); no admin UI to change
policies (D1 rows editable manually); admission rows accumulate (cleanup deferred).
Manual actions: approval, Git operations, deployment remain human-controlled.
**Acceptance:** MET — atomic enforcement verified; edge cases covered; quality gate green.

---

## PHASE 8 (subsequent) — Admin CMS

**Objective:** Admin dashboard (Workers-served UI), full RBAC UI. Numbering retained
from the original roadmap; this phase follows Quotas & Abuse Protection.

Tasks:
- [ ] Admin auth (separate from Telegram identity), session handling
- [ ] Sections per spec: dashboard, users, providers, keys, models, routing, quotas, tools, settings, feature flags, logs, audit logs
- [ ] Masked secrets everywhere; audit log for every admin change
- [ ] XSS/CSRF protection for UI

Tests: authorization tests (USER cannot reach admin), CSRF, XSS, audit log assertions.
**Acceptance:** full admin flow works with masked secrets and audit trail.

---

## PHASE 9 — Tasks & Automation

**Objective:** Natural-language reminders/tasks.

Tasks:
- [ ] `tasks` table; task creation from natural language
- [ ] Scheduling via Cloudflare Workflows (or cron trigger fallback — decide at phase start)
- [ ] Telegram notification delivery; retry + duplicate-execution protection

Tests: schedule/retry/duplicate tests with fake time.
**Acceptance:** "remind me tomorrow at 9" fires a Telegram message.

---

## PHASE 10 — Advanced Agent

Justified features only, decided at phase start: smart model routing (FAST/DEFAULT/COMPLEX/RESEARCH), research mode, semantic memory (embeddings + vectorize), cost analytics, multimodal/voice, additional tools, prompt versioning UI.

---
