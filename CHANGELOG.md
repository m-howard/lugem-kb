# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Bun workspace monorepo: `apps/docs` (Docusaurus), `apps/gateway` (Bun + Hono), `infra/pulumi`.
- Gateway serving the built documentation site alongside a read-only API: `/healthz`, `/readyz`,
  `GET /v1/documents`, `GET /v1/documents/:path`, `POST /v1/search`.
- Key policy confining corpus reads to a configured prefix and permitted extensions, refused
  before any upstream call.
- Retrieval over a Bedrock knowledge base returning passages with citations, and an explicit
  no-coverage response when nothing clears the relevance threshold.
- Pulumi program deploying into an **existing** VPC: ECR, ECS Fargate, ALB, S3 corpus bucket, and
  a Bedrock knowledge base backed by S3 Vectors.
- `scripts/docs/sync-corpus.ts` — uploads markdown to S3, deletes retracted objects, and waits for
  ingestion to reach a terminal state.
- Test suite: colocated unit tests, HTTP integration tests including route precedence, and
  Playwright e2e against a real server and a real build. Coverage gate at 80%.
- CI: lint, typecheck, tests with coverage, site and image build, and `pulumi preview` on
  infrastructure changes.
- ADRs 0001–0009 recording the decisions behind the above, and what each one costs.
- Open-source governance: MIT license, contributing guide, security policy, code of conduct,
  issue and pull request templates.

### Changed

- TypeScript pinned to `~6.0.3`: `typescript-eslint@8.66.0` — the only line supporting
  `eslint@10` — declares `typescript >=4.8.4 <6.1.0`, so 7.x breaks type-aware linting on install.
  See [ADR 0002](docs/adr/0002-typescript-pinned-to-6-x.md).
- Single lockfile. The scaffolded plan to commit `bun.lock` and `pnpm-lock.yaml` side by side was
  dropped; see [ADR 0007](docs/adr/0007-single-lockfile-no-pnpm-parity.md).
- Node pinned to 24 LTS, up from 22.
- Indentation set to two spaces for JS/TS, down from four.
- Docusaurus keeps numeric filename prefixes in URLs, so an ADR's number survives into the route
  a citation resolves to.

### Removed

- Stale `spec/` entries from `.prettierignore` and `.markdownlintignore` — no such tree exists.

[Unreleased]: https://github.com/m-howard/lugem-kb/commits/main
