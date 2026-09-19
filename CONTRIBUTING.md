# Contributing

[Back to the README](README.md) · [Development](DEVELOPMENT.md) · [Testing](TESTING.md) · [Security](SECURITY.md)

## Before submitting a change

- Keep the change focused and preserve existing boundaries.
- Do not include secrets, `.dev.vars`, generated local state, or production data.
- Add or update tests for behavior changes, especially security and persistence behavior.
- Update documentation when commands, configuration, architecture, or operations change.
- Run `npm run check` when practical and report pre-existing failures accurately.

## Review expectations

Reviewers should be able to identify the changed boundary, migration impact, test evidence, and deployment implications. Changes must not silently broaden Telegram chat access, ownership scope, tool authority, credential exposure, or production fallback behavior.

## Git safety

Do not commit, push, deploy, alter Cloudflare resources, register webhooks, or modify secrets as part of routine local development without explicit project-owner instruction.
