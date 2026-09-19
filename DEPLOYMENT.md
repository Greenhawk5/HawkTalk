# Deployment guide

[Back to the README](README.md) · [Security](SECURITY.md) · [Rollback](docs/ROLLBACK.md)

Deployment is human-controlled. `wrangler.toml` leaves staging and production remote bindings absent until they are provisioned.

## Environments

- **Local:** Wrangler dev with local D1 and `.dev.vars`.
- **Staging:** configuration placeholder; provision bindings and secrets before use.
- **Production:** provision Cloudflare resources, apply reviewed migrations, configure secrets, generate types, deploy, register the Telegram webhook, and run smoke tests.

## Operational entry points

Use [docs/DEPLOYMENT-RUNBOOK.md](docs/DEPLOYMENT-RUNBOOK.md) for provisioning and first release, [docs/SMOKE-TESTS.md](docs/SMOKE-TESTS.md) after deployment, and [docs/ROLLBACK.md](docs/ROLLBACK.md) for rollback or webhook disablement.

## Required resources

Production semantic memory requires D1, a Vectorize index compatible with the embedding implementation, and Workers AI. The Worker also requires Telegram and credential-encryption secrets. Never put secret values in `wrangler.toml`, migrations, docs, or source.

## Safe sequence

1. Run local validation and review the diff.
2. Provision or verify Cloudflare resources and bindings manually.
3. Configure secrets manually.
4. Apply migrations in order and verify the target database.
5. Generate Worker types and run the dry-run build.
6. Deploy only with explicit human approval.
7. Register or verify the Telegram webhook and execute smoke tests.

This documentation pass performs none of the remote actions above.
