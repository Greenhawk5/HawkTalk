# HawkTalk Agent — Security Model

Security controls are implemented per phase and listed here as they land. Nothing in this document is aspirational — if a control is listed, it exists in code and is tested.

## Threat model summary

| Threat | Control | Phase |
|---|---|---|
| Forged Telegram webhooks | secret-token header check with constant-time compare; missing/empty server secret fails closed; Telegram offers no separate signature scheme | 2 |
| Telegram credential leak | token only in Worker secret; never logged/returned | 2 |
| Telegram reply duplicates | bounded client retry (network/timeout only, max 2 attempts); never retry after any response; claim released only on failure + 500 so redelivery reprocesses | 2 |
| Oversized webhook payloads | 256 KiB body cap → 413; strict content-type + JSON + update_id validation | 2 |
| Cross-user data access | user-scoped queries enforced in `db/` layer + tests | 2–5 |
| Conversation data tampering | every Phase 5 conversation/message statement scoped by internal `users.id`; UUIDv4 ids validated (regex + length CHECK); FK cascade delete; ownership mismatch impossible via repository predicates + tests | 5 |
| Conversation content leakage | content stored/returned byte-for-byte with no scanning/redaction/heuristics; never logged; metadata/structured fields rejected so credentials cannot ride along | 5 |
| Secret auto-loading in tests | Vitest explicitly disables Wrangler dotenv loading (`CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false`, `CLOUDFLARE_INCLUDE_PROCESS_ENV=false`, nonempty `envFiles`); typecheck/build require explicit safe environment settings too | 5 |
| Caller-controlled conversation timestamps | Public service operations accept no timestamp input; injected `Clock` defaults to the runtime clock; `seq` determines ordering | 5 |
| Archived conversation reactivation | Dedicated repository archive operation only writes `archived`; no generic status-update or unarchive API; archived appends are rejected | 5 |
| Duplicate update double-processing | `update_id` idempotency table | 2 |
| Untrusted agent input | full request/config/message/metadata validation with central bounds; prototype-pollution keys rejected | 3 |
| Provider output/error leakage | generic AgentError codes only; raw throwables mapped to internal; provider text length-capped; core emits zero logs | 3 |
| Provider key leak | masked display only (`sk-…9a31`); keys in secrets, never D1-plaintext/logs/UI | 4 |
| Unbounded AI/tool spend | per-request budgets (context/message/output caps, provider timeout) | 3 |
| Unbounded user spend | quotas + rate limits | 7 |
| Prompt injection via web content | untrusted-content delimiting; external text never treated as instructions | 6 |
| SSRF via web_fetch | block loopback/private/link-local/metadata targets; validate redirects; size/time/type limits | 6 |
| Privilege escalation | RBAC enforced backend-side; Telegram identity is an identifier, not authorization | 7–8 |
| Admin panel attacks | separate auth, session handling, CSRF, output encoding (XSS), audit log | 8 |
| SQL injection | prepared statements only | all |
| Secret exposure in repo | `.gitignore` covers `API-Key`, `.env*`, `.dev.vars*`; verified | 0 |
| Response tampering / caching | `Cache-Control: no-store`, `X-Content-Type-Options`, strict CSP, `Referrer-Policy` on every response | 1 |
| Error detail leakage | fail-closed 500 with generic body; logs contain only `{event, request_id}` | 1 |
| Request-ID spoofing | server-generated UUID always, caller `X-Request-ID` ignored | 1 |
| Known vulnerable tooling | `npm audit --audit-level=low` in `npm run check`; sharp override 0.35.4 | 1 |

## Ground rules (enforced across all phases)

1. Never log: bot tokens, API keys, raw message content of private conversations, full internal errors to users. Conversation/message content (Phase 5) is treated the same: opaque, never logged, never transformed.
2. User-facing errors are generic ("Something went wrong"); diagnostic detail goes to sanitized internal logs only.
3. All external content (search results, fetched pages, tool outputs) is untrusted data — never instructions. Stored conversation content is likewise never treated as instructions by the persistence layer (no heuristics of any kind).
4. Every DB query is user-scoped at the data-access layer; UI restrictions are never the only control. Phase 5 conversations/messages are additionally keyed by internal `users.id`, never Telegram IDs.
5. Destructive/admin actions require confirmation and are audit-logged without sensitive payloads. Conversation delete cascades to messages atomically at the FK level.
6. Retries are bounded everywhere (providers, tools, workflows, Phase 5 sequence allocation) — no infinite loops.

## Secret inventory (production)

| Secret | Mechanism | Set by |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | `wrangler secret put` | human |
| `TELEGRAM_WEBHOOK_SECRET` | `wrangler secret put` | human |
| LLM API keys | `wrangler secret put` / admin-entered, masked in UI | human/admin |
| Search API key (Phase 6) | `wrangler secret put` | human |

The `API-Key` file in the repo root is gitignored and must never be read into code, docs, or logs.

## Verify before any deploy (human checklist)

- [ ] `git status` clean of secrets; `API-Key` still ignored (`git check-ignore API-Key`)
- [ ] All secrets set via `wrangler secret put`, none pasted in `wrangler.toml`
- [ ] Webhook registered with secret; HTTPS only
- [ ] D1 migrations applied; no manual production schema edits
