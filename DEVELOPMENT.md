# Development guide

[Back to the README](README.md) · [Testing](TESTING.md) · [Architecture](ARCHITECTURE.md)

## Prerequisites

- Node.js `>=22.13.0 <23`
- npm and Wrangler
- PowerShell or an equivalent shell

Install dependencies with `npm install`. If npm reproduces the repository's documented arborist issue, use the existing workaround rather than changing dependency versions casually.

## Local setup

```powershell
Copy-Item .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

`.dev.vars` is local-only and ignored. Telegram secrets are optional for health and unit tests; the webhook path fails closed without the required secret.

## Project map

See [ARCHITECTURE.md](ARCHITECTURE.md) for boundaries. `src/` contains runtime code, `tests/` contains Vitest suites, `migrations/` contains ordered D1 migrations, and `docs/` contains operational detail.

## Validation

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run security
npm run check
```

Run focused tests with `npx vitest run tests/memory.test.ts` or another relevant test file.

## Providers, tools, and memory

New model providers implement the provider boundary and keep credentials inside the AI adapter/router layer. New tools must have validated inputs, bounded execution/output, generic failure categories, and malformed-input/timeout tests. Memory changes must preserve owner filtering, explicit command semantics, untrusted context delimiters, and fail-closed behavior when Workers AI or Vectorize is unavailable.

## Migrations

Add a new numbered SQL migration; do not edit an applied migration. Test replay/idempotency and update database tests when schema changes. Remote migration application is covered by [DEPLOYMENT.md](DEPLOYMENT.md).

## Contribution workflow

Keep changes focused, run relevant tests and `npm run check`, inspect the final diff for secrets, and update documentation when behavior or operational steps change. See [CONTRIBUTING.md](CONTRIBUTING.md).
