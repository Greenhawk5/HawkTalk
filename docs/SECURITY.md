# HawkTalk security

[Back to the README](../README.md) · [Deployment](../DEPLOYMENT.md) · [Contributing](../CONTRIBUTING.md)

This document describes controls implemented in the current repository. It is not a certification, penetration-test report, or guarantee of operational security.

## Implemented controls

- Webhook secret verification uses a constant-time comparison; malformed, oversized, unauthorized, and unsupported requests are bounded and handled safely.
- Telegram conversational processing is restricted to private chats. Internal user IDs, conversation rows, messages, and semantic-memory records are owner-scoped.
- `processed_updates` and processing states provide durable idempotency. Redeliveries do not regenerate started AI work or double-charge admission/usage ledgers.
- Roles, quotas, rate windows, blocked-user handling, admin authorization, destructive-action confirmations, and append-only audit records are enforced server-side.
- Provider credentials are encrypted at rest in D1 and decrypted only with the Worker secret. Secrets and upstream error details are not returned to users or ordinary logs.
- Agent Core, tool parsing, execution, web fetch, response sizes, history, memory context, and retries have explicit bounds.
- SSRF protections block local, private, link-local, metadata, multicast, and unsupported network targets. External content is marked untrusted before model use.
- Missing production secrets, D1, Workers AI, or Vectorize dependencies fail closed or disable the dependent capability.

## Operational responsibilities

Keep `.dev.vars`, Worker secrets, Telegram tokens, encryption keys, Cloudflare credentials, provider keys, and private endpoints out of Git, logs, issues, screenshots, and documentation. Review bindings before production, rotate compromised credentials, apply migrations deliberately, and run the smoke-test checklist after deployment.

## Reporting

This checkout does not define a public security contact or repository URL. Do not open a public issue with credentials or exploit details. If the project is published, add a private reporting channel here before release.

## Future hardening

Operational alerting, formal incident procedures, secret rotation automation, and a maintained public disclosure channel are not established by the current repository.
