# Changelog

All notable changes to HawkTalk are documented in this file.

This changelog follows the principles of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and release numbers follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

Changes that are not yet part of a tagged release will be documented here.

### Planned

* Post-release refinements and maintenance for the `1.0.x` line.
* Continued improvements to production observability and operational tooling.
* Additional hardening and end-to-end coverage as the project evolves.

---

## [1.0.0-rc.1] — 2026-09-20

### Added

* Comprehensive repository documentation structure.
* Complete project README covering architecture, capabilities, technology stack, setup, configuration, providers, tools, memory, and operational documentation.
* Detailed architecture documentation covering:

  * Runtime layers
  * Telegram request lifecycle
  * Provider architecture
  * Persistence
  * Memory architecture
  * Tool architecture
  * Security boundaries
  * Environment separation
* Dedicated development guide.
* Dedicated testing and validation guide.
* Dedicated deployment guide.
* Production deployment runbook.
* Production smoke-test checklist.
* Worker rollback procedure.
* Repository security policy.
* Detailed security model documentation.
* Contribution guidelines.
* Code of Conduct.
* Support documentation.
* Third-party notices.
* Repository hardening checklist.
* `CITATION.cff` metadata.
* GitHub `CODEOWNERS`.
* Dependabot configuration.
* Continuous Integration workflow.
* CodeQL security-analysis workflow.
* GitHub issue templates for bug reports and feature requests.
* Pull Request template.
* GitHub security contact configuration.

### Changed

* Overhauled the repository's documentation structure to provide a consistent and maintainable documentation system.
* Clarified the project's current development and release status.
* Documented the current Cloudflare Workers, D1, Vectorize, Workers AI, Telegram, AI provider, tool, and memory architecture.
* Consolidated development, testing, deployment, security, and operational guidance into dedicated documents.
* Established a standardized GitHub repository workflow for contributions and maintenance.
* Updated project metadata for the first Release Candidate.

### Security

* Documented Telegram webhook authentication requirements.
* Documented owner-scoped data isolation requirements.
* Documented durable webhook idempotency.
* Documented encrypted provider credential storage.
* Documented SSRF protections for web tools.
* Documented prompt-injection boundaries for external research and memory.
* Added repository hardening guidance.
* Added automated security analysis through CodeQL.
* Added automated dependency update configuration through Dependabot.

### License

* HawkTalk is now released under the **MIT License**.
* Added the standard MIT License text to the repository.
* Updated repository metadata and documentation to identify MIT as the project license.

### Release

* Published the first Release Candidate of HawkTalk:
  **`1.0.0-rc.1`**
* This release candidate represents the documentation and repository-structure baseline being prepared for the upcoming stable `1.0.0` release.

---

## Release policy

Future releases should:

1. update this file before tagging,
2. describe user-visible and operationally relevant changes,
3. distinguish `Added`, `Changed`, `Fixed`, `Security`, `Removed`, and `License` changes where applicable,
4. include a release date,
5. reference the corresponding Git tag.

[Unreleased]: https://github.com/Greenhawk5/HawkTalk/compare/v1.0.0-rc.1...HEAD
[1.0.0-rc.1]: https://github.com/Greenhawk5/HawkTalk/releases/tag/v1.0.0-rc.1
