# Development Guide

[Back to README](README.md) · [Testing](TESTING.md) · [Architecture](docs/ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md)

## Prerequisites

- Node.js `>=22.13.0 <23`
- npm
- Wrangler
- PowerShell or an equivalent shell

## Local setup

```powershell
git clone https://github.com/Greenhawk5/HawkTalk.git
cd HawkTalk
npm install
Copy-Item .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

The local Worker is configured around Wrangler's local D1 state. Do not use production bindings for routine development.

## Project structure

```text
src/            Runtime implementation
tests/          Vitest suites
migrations/     Ordered D1 migrations
scripts/        Operational/provisioning utilities
docs/           Detailed architecture and operations
.github/        CI, templates, dependency automation
```

## Validation

```bash
npm run types
npm run typecheck
npm run lint
npm test
npm run build
npm run security
npm run check
```

## Focused tests

```bash
npx vitest run tests/memory.test.ts
npx vitest run tests/<relevant-suite>.test.ts
```

## Providers

Add or modify providers through the provider abstraction rather than coupling Telegram or Agent Core to a specific vendor.

Provider credentials must remain inside the AI credential boundary. Do not pass API keys through chat, commit them to source, or add them to general-purpose logs.

## Tools

New tools must have:

- validated input,
- bounded execution,
- bounded output,
- safe failure behavior,
- tests for malformed input,
- timeout / failure tests,
- explicit treatment of external data as untrusted.

## Memory

Memory changes must preserve:

- internal-user ownership scoping,
- explicit command semantics,
- untrusted-context delimiters,
- safe degradation when Workers AI or Vectorize is unavailable.

## Database migrations

Add a new numbered migration.

Do not:

- edit an already-applied migration,
- reorder migration numbers,
- silently change ownership semantics,
- remove compatibility needed by the previous application version.

Test migration replay/idempotency when schema behavior changes.

## Local secret handling

`.dev.vars` is intentionally ignored. Never commit it.

For production, use:

```bash
wrangler secret put <SECRET_NAME> --env production
```

Do not use command-line arguments to transmit provider API keys.

## Release discipline

Before a release:

1. run `npm run check`,
2. inspect the final diff,
3. update CHANGELOG,
4. verify documentation,
5. confirm no secrets are staged,
6. create a release tag only from the intended reviewed commit.
