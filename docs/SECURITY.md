# HawkTalk Security Model

[Back to README](../README.md) · [Security Policy](../SECURITY.md)

This document describes the security controls represented by the current architecture. It is not a security certification or penetration-test report.

## Request security

The Telegram webhook path is expected to:

- validate the expected secret header,
- use constant-time comparison,
- reject unsupported methods and content types,
- bound request-body size,
- reject malformed JSON,
- validate Telegram update structure,
- produce generic user-facing failures.

## Identity and isolation

HawkTalk processes conversational traffic for private chats.

User-owned data is scoped by the application's internal user identity rather than raw Telegram identifiers.

Ownership controls must exist at the data-access layer, not only in handler code.

## Idempotency

Telegram deliveries may be retried.

`processed_updates` and processing state provide durable idempotency so that redeliveries do not regenerate already-started model work or duplicate usage effects.

## Credentials

Provider credentials are encrypted before storage in D1.

The encryption master secret is supplied through the Worker secret system and never stored in source.

Credentials must not travel through:

- Telegram messages,
- chat history,
- ordinary logs,
- shell arguments,
- pull requests.

## Agent Core boundary

Agent Core is intentionally isolated from:

- Telegram,
- D1,
- provider-specific credentials,
- direct network access,
- global mutable state.

This reduces the blast radius of transport- and provider-specific logic.

## Tool security

Tool inputs and external content are untrusted.

The web layer enforces bounded execution and blocks unsafe network targets, including local, private, link-local, metadata, multicast, and unsupported schemes where applicable.

External text is explicitly delimited before it is placed into model context.

## Prompt-injection resistance

Research results and retrieved memory are data, not instructions.

Tool outputs and memory context must never silently become higher-priority instructions than the system and application policies.

## Administration

Administrative operations require server-side authorization.

Destructive actions use explicit confirmation state rather than relying on button visibility alone.

Audit records should not contain plaintext credentials.

## Availability and abuse controls

The application includes:

- admission policy,
- quotas,
- rate windows,
- blocked-user handling,
- bounded retries,
- bounded tool execution,
- bounded context and output sizes.

## Fail-closed behavior

Missing critical dependencies should not produce permissive fallback behavior.

Examples include:

- missing webhook secret → reject webhook traffic,
- unavailable provider credentials → do not expose or fabricate credentials,
- unavailable memory dependencies → disable memory while preserving ordinary conversation where designed,
- unauthorized admin request → reject server-side.

## Operational responsibilities

Operators must:

- rotate exposed credentials,
- keep `.dev.vars` untracked,
- review Cloudflare bindings,
- apply migrations deliberately,
- review deployment diffs,
- run smoke tests after deployment,
- avoid placing production user data in issue reports.

## Known documentation gaps

The repository should continue to improve:

- incident response,
- formal secret-rotation procedures,
- production alerting,
- a maintained private disclosure channel,
- periodic dependency and configuration review.
