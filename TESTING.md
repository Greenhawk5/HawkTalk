# Testing and validation

[Back to the README](README.md) · [Development](DEVELOPMENT.md) · [Security](SECURITY.md)

## Tooling

The repository uses Vitest with `@cloudflare/vitest-pool-workers`, local D1 bindings, TypeScript, ESLint, Wrangler dry-run builds, and npm audit.

## Commands

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run security
npm run check
```

`npm run check` runs type generation/typechecking, linting, tests, a Wrangler dry-run build, and the dependency audit.

## Coverage areas

Tests cover routing and Worker behavior, Telegram parsing/webhooks/idempotency, Agent Core validation, provider adapters and routing, conversations and D1 schema, admission/quota behavior, orchestration, tools/SSRF/research, admin authorization and confirmations, usage, and semantic memory. The test suite is the source of truth for exact case counts.

## Security-sensitive changes

Preserve tests for webhook authentication, private-chat isolation, duplicate delivery, owner scoping, credential sealing, generic errors, SSRF blocking, prompt/tool delimiters, quota atomicity, admin authorization, confirmation expiry, audit behavior, and fail-closed bindings.

## Production smoke tests

After a human-controlled deployment, use [docs/SMOKE-TESTS.md](docs/SMOKE-TESTS.md). Local tests and dry-run builds do not prove Telegram delivery, Cloudflare bindings, provider availability, or production routing.
