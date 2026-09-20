# Testing and Validation

[Back to README](README.md) · [Development](DEVELOPMENT.md) · [Security](SECURITY.md)

## Test stack

HawkTalk uses:

- Vitest,
- `@cloudflare/vitest-pool-workers`,
- local D1 bindings,
- TypeScript,
- ESLint,
- Wrangler dry-run builds,
- npm audit.

## Full validation

```bash
npm run check
```

This performs:

```text
type generation
→ TypeScript
→ ESLint
→ Vitest
→ Wrangler dry-run
→ npm audit
```

## Coverage areas

The test suite is expected to cover the major security and ownership boundaries, including:

- Worker routing,
- webhook authentication,
- Telegram parsing,
- durable update idempotency,
- internal-user identity,
- admission / quotas / rate windows,
- Agent Core validation and bounds,
- provider routing and credential behavior,
- conversation ownership and sequence allocation,
- tool input validation,
- SSRF defenses,
- web research bounds,
- administration and confirmations,
- usage recording,
- semantic memory isolation and graceful degradation.

## Security-sensitive testing

Changes touching security boundaries should preserve or add tests for:

- incorrect webhook secrets,
- oversized requests,
- malformed Telegram updates,
- duplicate delivery,
- cross-user access,
- blocked users,
- unauthorized admin actions,
- credential sealing,
- provider failure / failover,
- generic error handling,
- private / metadata / local network URL rejection,
- prompt-injection delimiters,
- bounded tool output,
- memory ownership filters.

## Production smoke tests

A passing local test suite does not prove:

- Telegram can reach the deployed webhook,
- production secrets are configured,
- Cloudflare bindings are correct,
- provider credentials are valid,
- Vectorize is available,
- external websites are reachable.

Run [docs/SMOKE-TESTS.md](docs/SMOKE-TESTS.md) after a human-controlled deployment.
