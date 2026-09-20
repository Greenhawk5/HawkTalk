# Contributing to HawkTalk

Thank you for contributing to HawkTalk.

HawkTalk is structured around narrow security-sensitive boundaries. Contributions should preserve those boundaries unless changing them is the explicit purpose of the work.

## Before you start

Please read:

- [README.md](README.md)
- [DEVELOPMENT.md](DEVELOPMENT.md)
- [SECURITY.md](SECURITY.md)
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

For security vulnerabilities, do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## Development workflow

1. Create a focused branch.
2. Make the smallest coherent change.
3. Add or update automated tests.
4. Update documentation when behavior or operations change.
5. Run `npm run check`.
6. Review the final diff for secrets and unrelated files.
7. Open a pull request against `main`.

Suggested branch names:

```text
feature/...
fix/...
docs/...
refactor/...
test/...
chore/...
security/...
```

## Architecture rules

Preserve these project boundaries unless the change explicitly requires otherwise:

- Telegram code belongs in the Telegram adapter layer.
- Agent Core remains transport/provider/storage independent.
- D1 ownership checks must be enforced at the data-access boundary.
- Provider credentials never enter Telegram messages or normal logs.
- Tools must validate inputs and bound execution and output.
- External research results are untrusted context.
- Memory must remain user-scoped and fail safely when dependencies are unavailable.
- Database migrations are additive and ordered; do not rewrite applied migrations.

## Tests

At minimum, run:

```bash
npm run check
```

For focused development:

```bash
npx vitest run tests/<relevant-test>.test.ts
npm run typecheck
npm run lint
```

Security-sensitive changes should preserve or expand tests around authentication, ownership, idempotency, quotas, credential handling, SSRF, prompt/tool boundaries, confirmations, and fail-closed behavior.

## Documentation

Update documentation when changing:

- commands,
- environment variables,
- provider behavior,
- database schema,
- request flow,
- security controls,
- deployment steps,
- operational recovery,
- user-visible behavior.

Avoid documenting speculative features as if they were already implemented.

## Secrets

Never commit:

- `.dev.vars`
- `.env` files containing real values
- Telegram bot tokens
- provider API keys
- Cloudflare API tokens
- encryption keys
- production credentials
- private URLs containing credentials

## Commits

Prefer concise conventional-style messages:

```text
feat: add provider cooldown metrics
fix: prevent duplicate webhook processing
docs: update deployment runbook
test: cover memory ownership isolation
refactor: split tool registry from orchestration
chore: update worker dependencies
```

## Pull requests

A pull request should explain:

- what changed,
- why it changed,
- how it was tested,
- security implications,
- database / migration implications,
- deployment implications.

Keep unrelated refactors out of focused changes.

## Review standard

Reviewers should be able to identify:

- the changed architectural boundary,
- the test evidence,
- the migration impact,
- the security impact,
- the deployment impact.

Changes must not silently broaden Telegram access, ownership scope, tool authority, credential exposure, or production fallback behavior.
