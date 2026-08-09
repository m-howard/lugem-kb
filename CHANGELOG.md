# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Grounded answering.** `POST /v1/ask` retrieves first and generates only from the passages that
  cleared the relevance threshold, streaming the answer over server-sent events. The citations
  frame is emitted before the first token, so every answer carries at least one source. A question
  nothing covers returns plain JSON and never reaches the model. See
  [ADR 0012](docs/adr/0012-grounded-generation-behind-retrieval.md).
- **Ask the docs widget** on every documentation page, plus a full-page `/ask` route. Answers
  render as plain text, citations link to the page they came from and show its `last_reviewed`
  date, and the verbatim passage is one click away.
- Citation source URIs now resolve to site routes, and to the page's `last_reviewed` frontmatter.
  Both `/v1/search` and `/v1/ask` return `path`, `url` and `lastReviewed` alongside each citation.
- Per-client rate limiting on `/v1/ask` — a cost guard on the one endpoint that bills per request.
- New gateway variables: `ANSWER_MODEL_ID` (required), `ANSWER_MAX_TOKENS`,
  `ASK_RATE_LIMIT_PER_MINUTE`. New stack keys: `answerModelId`, `answerModelRegions`,
  `answerMaxTokens`, `askRateLimitPerMinute`, `retrievalScoreThreshold`.
- Task role gains `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream`, scoped to one
  model — including the underlying foundation models when a cross-region inference profile is used.
- `scripts/dev/serve-dev.ts` — a local reverse proxy putting the site and the API on one origin,
  so the widget can be developed with hot reload without introducing CORS.
- **[Asking questions](docs/asking-questions.md)** — a reader's guide to the assistant.
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
- ADRs 0001–0012 recording the decisions behind the above, and what each one costs.
- Open-source governance: MIT license, contributing guide, security policy, code of conduct,
  issue and pull request templates.

### Changed

- **Answer generation is no longer out of scope.** The retrieval-only stance in the README and in
  `kb/retrieve.ts` is superseded by [ADR 0012](docs/adr/0012-grounded-generation-behind-retrieval.md).
  `RetrieveAndGenerate` is still not used: retrieval and generation are composed here, so the
  score threshold and the citation set stay in this repository where they are tested.
- `docs:start` binds port 3001, leaving 3000 to the gateway so both can run at once.
- The ALB idle timeout is set to 120 seconds, up from the AWS default of 60, for streamed answers.
- Root `typecheck` now includes `apps/docs`, which nothing had been running. This required
  acknowledging TypeScript 6's `baseUrl` deprecation, since `@docusaurus/tsconfig` sets it.
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
