# Repository Hardening

This checklist records the repository-level controls recommended for HawkTalk.

## Secrets

- [ ] No `.dev.vars` or real `.env` files are committed.
- [ ] No Telegram bot tokens are present in tracked files.
- [ ] No provider API keys are present in tracked files.
- [ ] No Cloudflare API tokens are present in tracked files.
- [ ] Encryption keys remain outside Git.
- [ ] Any historically exposed secret has been rotated, not merely deleted.

## GitHub

- [ ] Dependabot is enabled.
- [ ] GitHub Actions use least-privilege permissions.
- [ ] Actions are pinned or reviewed intentionally.
- [ ] `main` is protected when collaborative development requires it.
- [ ] Secret scanning is enabled when available.
- [ ] Security Advisories / private vulnerability reporting is enabled when available.
- [ ] CODEOWNERS is configured for the maintained branch.
- [ ] Pull requests use the repository template.

## CI

- [ ] Type generation and TypeScript checks pass.
- [ ] ESLint passes with zero warnings.
- [ ] Vitest passes.
- [ ] Wrangler dry-run build passes.
- [ ] `npm audit` passes at the configured severity threshold.

## Cloudflare

- [ ] Production D1 bindings are intentional and reviewed.
- [ ] Workers AI / Vectorize bindings are intentional and reviewed.
- [ ] Production secrets are configured through Wrangler secret storage.
- [ ] Logs never expose user content, secrets, credentials, or raw provider errors.
- [ ] Webhook verification remains enabled.
- [ ] Administrative operations remain server-authorized.

## Releases

- [ ] CHANGELOG is updated.
- [ ] The intended license is committed before claiming one.
- [ ] A release tag points to the reviewed commit.
- [ ] Production smoke tests pass when applicable.
- [ ] Deployment and rollback procedures are documented.
