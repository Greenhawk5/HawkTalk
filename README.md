# HawkTalk

<p align="center">
  <img src="docs/assets/README/banner-placeholder.svg" alt="HawkTalk" width="100%" />
</p>

<p align="center">
  <strong>A Telegram-first, provider-independent AI assistant running on Cloudflare Workers.</strong>
</p>

<p align="center">
  <a href="https://github.com/Greenhawk5/HawkTalk">Repository</a>
  ·
  <a href="docs/ARCHITECTURE.md">Architecture</a>
  ·
  <a href="DEVELOPMENT.md">Development</a>
  ·
  <a href="SECURITY.md">Security</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript 5.9" />
  <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white" alt="Cloudflare Workers" />
  <img src="https://img.shields.io/badge/D1-SQLite-F38020?style=flat-square&logo=cloudflare&logoColor=white" alt="Cloudflare D1" />
  <img src="https://img.shields.io/badge/Vitest-4-6E9F18?style=flat-square&logo=vitest&logoColor=white" alt="Vitest" />
  <img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" alt="MIT License" />
</p>

> **Project status:** `1.0.0-rc.1` — Release Candidate 1.

## Overview

HawkTalk is a Telegram-first personal AI assistant designed around a narrow, security-conscious request path:

```text
Telegram
   ↓
Webhook admission
   ↓
Validation + idempotency + policy
   ↓
Application orchestration
   ↓
Provider-independent Agent Core
   ↓
AI Router / OpenAI-compatible providers
   ├── Web research tools
   └── Semantic memory
   ↓
D1 + Vectorize + Workers AI
   ↓
Telegram response
```

The project deliberately separates transport, admission, orchestration, model invocation, tools, memory, persistence, and administration so each boundary can be tested independently.

## Implemented capabilities

* Secure Telegram webhook verification and bounded request parsing.
* Private-chat-only conversational processing.
* Durable Telegram update idempotency.
* Owner-scoped conversations and messages in Cloudflare D1.
* Provider-independent Agent Core.
* OpenAI-compatible multi-provider routing with multiple credentials, bounded attempts, and cooldown/failover behavior.
* Encrypted provider credentials stored in D1.
* Role-aware admission controls, quotas, rate limits, abuse handling, confirmations, and audit logging.
* Read-only `web_search` and `web_fetch` tooling with strict bounds and SSRF protections.
* Research mode with explicitly untrusted external context.
* Explicit memory commands and semantic memory using Workers AI `@cf/baai/bge-m3` plus Vectorize.
* Usage and cost recording.
* Cloudflare-native local development and automated validation with Vitest.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the complete layer model, request lifecycle, persistence boundaries, provider architecture, tools, and security boundaries.

## Technology

| Area               | Current implementation                          |
| ------------------ | ----------------------------------------------- |
| Runtime            | Cloudflare Workers                              |
| Language           | TypeScript                                      |
| Relational storage | Cloudflare D1 / SQLite                          |
| Semantic vectors   | Cloudflare Vectorize                            |
| Embeddings         | Workers AI `@cf/baai/bge-m3`                    |
| Messaging          | Telegram Bot API                                |
| Model protocol     | OpenAI-compatible chat completions              |
| Testing            | Vitest + `@cloudflare/vitest-pool-workers`      |
| Validation         | TypeScript, ESLint, Wrangler dry-run, npm audit |

## Quick start

### Requirements

* Node.js `>=22.13.0 <23`
* npm
* Wrangler
* A local development configuration copied from `.dev.vars.example`

### Installation

```bash
git clone https://github.com/Greenhawk5/HawkTalk.git
cd HawkTalk
npm install
Copy-Item .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

On non-PowerShell shells, copy `.dev.vars.example` to `.dev.vars` with the equivalent command.

`.dev.vars` is local-only and must never be committed.

## Development commands

```bash
npm run dev                 # Start local Wrangler development
npm run db:migrate:local    # Apply D1 migrations to local state
npm run types               # Generate Wrangler environment types
npm run typecheck           # TypeScript validation
npm run lint                # ESLint with zero warnings allowed
npm test                    # Test suite
npm run build               # Wrangler dry-run build
npm run security            # npm audit
npm run check               # Full validation pipeline
```

`npm run check` is the repository's aggregate quality gate.

## Configuration and secrets

Development secrets are represented in `.dev.vars.example` and loaded from the ignored `.dev.vars` file.

Production secrets are configured separately with Wrangler and are never stored in source control.

The current secret categories include:

* Telegram bot token
* Telegram webhook verification secret
* Provider-credential encryption master secret
* Owner bootstrap identity

Never place a real token, API key, encryption key, private URL, or credential in Git, issues, screenshots, logs, or Telegram messages.

## Providers

HawkTalk uses a provider-neutral Agent Core and a common OpenAI-compatible provider adapter. Current architecture documentation describes support for providers such as OpenRouter, Z.AI, and Google Gemini through compatible endpoints.

Provider credentials are:

1. entered through the dedicated provisioning workflow,
2. sealed with AES-GCM before D1 storage,
3. kept outside Telegram chat history,
4. never printed in ordinary logs,
5. selected through bounded routing and cooldown logic.

See [docs/DEPLOYMENT-RUNBOOK.md](docs/DEPLOYMENT-RUNBOOK.md) for provisioning guidance.

## Research and tools

Research mode uses a deliberately constrained tool layer.

Tool execution is bounded by:

* validated tool inputs,
* network restrictions,
* fetch limits,
* output-size limits,
* retry limits,
* SSRF protection,
* explicit untrusted-content boundaries.

External pages and tool results must never be treated as trusted system instructions.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [SECURITY.md](SECURITY.md).

## Memory

HawkTalk separates durable conversation history from semantic memory.

Semantic memory uses:

```text
Workers AI
  @cf/baai/bge-m3
        ↓
   embeddings
        ↓
   Vectorize
        ↕
D1 memory metadata
```

Memory is always user-scoped. If the required AI or Vectorize capability is unavailable, memory degrades gracefully without breaking ordinary conversation.

## Documentation map

| Document                                                         | Purpose                                     |
| ---------------------------------------------------------------- | ------------------------------------------- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md)                          | System architecture and boundaries          |
| [DEVELOPMENT.md](DEVELOPMENT.md)                                 | Local development and contribution workflow |
| [TESTING.md](TESTING.md)                                         | Test strategy and validation                |
| [DEPLOYMENT.md](DEPLOYMENT.md)                                   | Deployment overview                         |
| [SECURITY.md](SECURITY.md)                                       | Security policy and vulnerability reporting |
| [CONTRIBUTING.md](CONTRIBUTING.md)                               | Contribution standards                      |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)                         | Community standards                         |
| [SUPPORT.md](SUPPORT.md)                                         | Support and issue-reporting guidance        |
| [CHANGELOG.md](CHANGELOG.md)                                     | Release history                             |
| [NOTICE.md](NOTICE.md)                                           | Third-party notices and project attribution |
| [CITATION.cff](CITATION.cff)                                     | Citation metadata                           |
| [REPOSITORY_HARDENING.md](REPOSITORY_HARDENING.md)               | Repository-level hardening checklist        |
| [docs/IMPLEMENTATION-ROADMAP.md](docs/IMPLEMENTATION-ROADMAP.md) | Implementation history and roadmap          |
| [docs/DEPLOYMENT-RUNBOOK.md](docs/DEPLOYMENT-RUNBOOK.md)         | Human-controlled production runbook         |
| [docs/SMOKE-TESTS.md](docs/SMOKE-TESTS.md)                       | Post-deployment verification                |
| [docs/ROLLBACK.md](docs/ROLLBACK.md)                             | Operational rollback procedures             |

## Repository status

HawkTalk `1.0.0-rc.1` is the first Release Candidate for the upcoming `1.0.0` release.

The project remains under active development. Release Candidate status means the current implementation is being prepared for stable release and may still receive fixes before `1.0.0`.

## License

HawkTalk is released under the **MIT License**.

See the [LICENSE](LICENSE) file for the complete license text.

## Author

**Ali Faniani / GreenHawk**

* GitHub: https://github.com/Greenhawk5
* Repository: https://github.com/Greenhawk5/HawkTalk
