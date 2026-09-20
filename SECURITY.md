# Security Policy

## Supported versions

HawkTalk is currently maintained from the `main` branch.

| Version / branch | Supported |
| --- | --- |
| `main` | Yes |
| Older releases | No public support commitment |

Until a stable public release process is established, `main` is the only maintained line.

## Reporting a vulnerability

Please **do not disclose security vulnerabilities through public GitHub Issues, Pull Requests, Telegram, or public chat**.

Use GitHub's private vulnerability reporting / Security Advisories for this repository when the feature is available:

https://github.com/Greenhawk5/HawkTalk/security

If private reporting is unavailable, contact the maintainer through a private GitHub communication channel.

## What to include

A useful report normally contains:

- a concise description of the vulnerability,
- the affected component or file,
- minimal reproduction steps,
- expected behavior,
- actual behavior,
- potential impact,
- a suggested mitigation, if known.

Sanitize all reports. Never include live Telegram bot tokens, API keys, encryption keys, Cloudflare tokens, private URLs, user message contents, or other credentials.

## HawkTalk-specific sensitive areas

Please pay particular attention to:

- Telegram webhook authentication,
- user / owner isolation,
- admin authorization and confirmation flows,
- provider credential encryption,
- provider routing and credential failover,
- D1 ownership queries,
- semantic-memory isolation,
- SSRF restrictions in web tools,
- prompt-injection boundaries,
- rate limits and quota accounting,
- secret leakage through logs or error responses,
- deployment bindings and Wrangler configuration.

## Credential exposure

If a token or credential has been exposed:

1. revoke or rotate it immediately,
2. preserve only sanitized evidence,
3. report the incident privately,
4. identify where the credential was exposed so the repository can be checked for recurrence.

Deleting a secret from the latest commit is not sufficient if it has already been pushed to a remote repository.

## Scope and limitations

This policy describes the project's intended reporting path. It is not a penetration-test report, security certification, or guarantee that every security issue has been identified.

See [docs/SECURITY.md](docs/SECURITY.md) for the implementation-level security model and [REPOSITORY_HARDENING.md](REPOSITORY_HARDENING.md) for repository controls.
