# Changelog

All notable changes to HawkTalk are documented in this file.

This changelog follows the principles of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and release numbers follow [Semantic Versioning](https://semver.org/).

## [1.0.0-beta.2] — 2026-09-21

### Highlights

* Centralized HawkTalk assistant identity and security policy: the assistant now speaks as HawkTalk in every conversation and never discloses its underlying model, provider, endpoints, routing, credentials, or system prompts — independent of which provider serves a given request.
* Telegram webhook reliability overhaul: the conversational pipeline runs in background execution (`waitUntil`) so Telegram's webhook deadline can no longer cancel an in-flight AI generation.
* Admin panel redesign: one editable panel message per chat with durable, D1-backed sessions, ownership binding, and inactivity expiration.

### Added

* `src/orchestration/identity.ts`: a single, provider-agnostic source for the HawkTalk identity/security policy, injected at the application → Agent Core boundary so it survives provider failover unchanged.
* Durable admin panel sessions (`admin_panel_sessions` table, migration `0011_admin_panel_sessions.sql`): one live panel message per chat, bound to the opening admin, with a 5-minute inactivity expiry refreshed on every valid interaction.
* Scheduled Worker cleanup (`scheduled` handler, cron): deletes expired admin panels' Telegram messages best-effort and removes their session rows; no in-isolate timers are used for panel lifetime.
* New documentation: `docs/ADMIN-PANEL.md` describing the actual panel lifecycle.
* New test suites covering identity invariants, admin panel session lifecycle, and background webhook processing.
* Comprehensive documentation structure (architecture, development, testing, deployment, runbook, smoke tests, rollback, security model, support, notices, hardening checklist) and GitHub project configuration (issue/PR templates, CodeQL, Dependabot, Codeowners).

### Changed

* Webhook processing: after the durable claim is taken, the webhook returns HTTP 200 immediately and the full conversational flow (user upsert, memory/routing commands, Agent Core, AI Router, persistence, Telegram delivery) continues under `ExecutionContext.waitUntil`. Synchronous execution remains as a fallback when no `waitUntil` is supplied (tests and non-worker callers). The durable processing state machine (`claimed → generating → completed | failed`) is unchanged: redeliveries never regenerate already-started work.
* Admin panel UX: every button press edits the same panel message (`editMessageText`) instead of stacking new messages; callbacks must match both the chat's live session message id and the session's Telegram user id (fail closed), with server-side authorization re-checked per action.
* Telegram client gained `editMessageText` and `deleteMessage` support with bounded error handling.
* Project licensing: HawkTalk is released under the MIT License.
* Standardized admission and admin error wording.
* Expanded `docs/SECURITY.md` with the assistant identity/confidentiality policy.

### Security

* The conversational assistant no longer self-identifies as the underlying model: identity questions answer as HawkTalk, and voluntary disclosure of model/vendor/provider identifiers, endpoints, credentials, routing details, or hidden instructions is prohibited by the composed system prompt.
* User-provided text, recalled memory, and tool/web results are treated as untrusted data that never outrank the identity policy (prompt-injection boundary).
* Admin panel callback authorization: ownership binding (actor + chat + message) is enforced against durable session state, never against callback data alone.
* Automated security analysis through CodeQL and dependency updates through Dependabot.
* Added repository hardening guidance.

### Documentation

* Complete project README covering architecture, capabilities, technology stack, setup, configuration, providers, tools, memory, and operational documentation; consolidated development, testing, deployment, security, and operational guidance into dedicated documents.
* Established contribution guidelines, Code of Conduct, support documentation, third-party notices, and `CITATION.cff` metadata.

---

## [1.0.0-beta.1] — 2026-09-20

The first tagged public pre-release of HawkTalk, covering the initial phased implementation:

* Cloudflare Workers foundation (Phase 1).
* Telegram webhook transport with secret-header validation, request bounding, and durable update idempotency (Phase 2).
* Provider-independent Agent Core (Phase 3) and the AI provider/routing layer with encrypted credential storage (Phase 4).
* Durable conversation memory in D1 (Phase 5).
* End-to-end conversational orchestration with admission control (Phase 6).
* Tool system with constrained `web_search`/`web_fetch`, SSRF protections, and explicit untrusted-content boundaries (Phase 7).
* Quotas and abuse protection (Phase 8).
* Admin command surface with server-side authorization and audit records (Phase 9).
* Semantic memory powered by Workers AI embeddings and Vectorize (Phase 10).
* Production documentation baseline.

---

## Release policy

Future releases should:

1. update this file before tagging,
2. describe user-visible and operationally relevant changes,
3. distinguish `Added`, `Changed`, `Fixed`, `Security`, `Removed`, and `License` changes where applicable,
4. include a release date,
5. reference the corresponding Git tag.

[Unreleased]: https://github.com/Greenhawk5/HawkTalk/compare/v1.0.0-beta.2...HEAD
[1.0.0-beta.2]: https://github.com/Greenhawk5/HawkTalk/releases/tag/v1.0.0-beta.2
[1.0.0-beta.1]: https://github.com/Greenhawk5/HawkTalk/releases/tag/v1.0.0-beta.1
