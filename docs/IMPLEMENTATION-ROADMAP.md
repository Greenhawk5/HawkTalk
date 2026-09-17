# HawkTalk Agent — Implementation Roadmap

Source of truth for the phase-by-phase build. Update after every change of status.

Status legend: `[ ]` Not started · `[-]` In progress · `[x]` Completed · `[!]` Blocked

---

## Current repository state (audited 2026-09-17, updated after Phase 2)

- Git repo on `main`, baseline commit `46db0bc` + uncommitted work: `/temp` ignore rule and Phase 2 implementation (uncommitted by policy).
- Phase 1 foundation (Worker, `/healthz`, D1, Vitest pool, ESLint, strict TS) intact and green.
- Phase 2 implemented: Telegram transport (`src/telegram/`, `src/db/telegram.ts`, `migrations/0002_telegram.sql`, webhook route).
- `API-Key` remains untracked + gitignored — never read, never exposed.
- Toolchain: Node v22.17.0, Wrangler 4.133.0, `npm run check` green.
- Constraint: Windows 11 host; commands must be git-bash compatible.

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

**Objective:** Working conversational agent with a single default provider.

Tasks:
- [ ] Provider interface (`AIProvider`) + first concrete provider
- [ ] Conversation engine: conversations/messages tables, context construction
- [ ] System prompt (HawkTalk identity), context window management
- [ ] Response pipeline: user msg → context → LLM → reply
- [ ] Execution budget (max tokens, max turns)

Tests: pipeline unit tests with mocked provider, empty/long message, provider failure → graceful error.
Manual actions: provide a real LLM API key as a secret.
**Acceptance:** natural conversation works through Telegram locally.

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

**Objective:** Short-term context + long-term memory, user-scoped.

Tasks:
- [ ] `memories` table + memory engine (write rules, retrieval, reset)
- [ ] Semantic-memory architecture placeholder (interface, not implementation)
- [ ] Context assembly: recent history + relevant memory
- [ ] Cross-user isolation enforcement at data-access layer

Tests: memory CRUD, isolation tests (user A cannot read user B), injection into context, reset.
**Acceptance:** "remember that…" persists and only the owner sees it.

---

## PHASE 6 — Tools & Web

**Objective:** Tool registry + web_search + web_fetch with strong SSRF/injection defense.

Tasks:
- [ ] Tool registry (name, schema, permissions, execute)
- [ ] web_search (provider-abstracted: e.g. Brave/Tavily)
- [ ] web_fetch with SSRF protection (private IP/loopback/metadata block, redirect revalidation, size/time/content-type limits)
- [ ] Prompt-injection defense: external content demarcated as untrusted
- [ ] Tool budgets per execution

Tests: malicious URL matrix (localhost, private ranges, metadata endpoint, redirects), oversized responses, injection payload in fetched content, tool loop termination.
**Acceptance:** security test suite passes; agent can search and summarize a URL.

---

## PHASE 7 — Quotas & Abuse Protection

**Objective:** Roles, quotas, rate limits, usage tracking.

Tasks:
- [ ] RBAC: OWNER/ADMIN/VIP/USER/BLOCKED
- [ ] Quota engine (messages/day etc., configurable) + usage tracking
- [ ] Rate limits (per-second, hourly burst) separate from quotas
- [ ] Blocked user handling; admin bypass policy

Tests: quota exhausted, rate limited, blocked user, admin bypass, duplicate-update quota double-charge.
**Acceptance:** limits enforced; edge cases covered.

---

## PHASE 8 — Admin CMS

**Objective:** Admin dashboard (Workers-served UI), full RBAC.

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
