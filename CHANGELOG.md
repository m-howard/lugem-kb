# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **The gap feedback loop** — Phase 5 of [the requirements](docs/requirements.md), so the
  documentation learns what it is missing. Off unless `GAP_FEEDBACK_TABLE` is set.
  - A question the corpus cannot answer is recorded, and readers can mark an answer unhelpful with
    an optional reason. An answered question is never recorded, and no record carries who asked.
  - Retention is a per-item DynamoDB TTL, defaulting to ninety days, rather than a policy someone
    has to remember. This settles open question Q11 — see
    [ADR 0015](docs/adr/0015-recording-documentation-gaps.md).
  - The gateway task role holds `dynamodb:PutItem` and nothing else, so the service collecting
    reader questions cannot read one back. A separate role, in its own deployment environment, holds
    the read.
  - A weekly workflow groups the gaps, attributes each to the documentation area it came closest to,
    and keeps one rolling GitHub issue up to date naming the CODEOWNERS owner — so a gap arrives as
    an assignable authoring task. Run it on demand with `bun run gaps:report -- --dry-run`.
  - Retrieval now keeps the highest-scoring result that missed the relevance threshold, so a
    no-coverage question can name an area instead of arriving unattributed. No behaviour a reader
    sees changes.
- **Reader authentication, built and switched off** — `READER_AUTH_REQUIRED` requires readers to
  sign in for `/v1/ask`, `/v1/search` and `/v1/feedback`, and defaults to `false`. With it off,
  those routes behave exactly as before and no ALB listener rule is created. Auth configuration is
  lifted out of the CMS block so a deployment can authenticate readers without running a CMS; the
  environment variable names are unchanged. The rate limiter keys on the reader's subject when
  there is one, so an office behind a single NAT no longer shares one allowance. See
  [ADR 0016](docs/adr/0016-reader-authentication.md).

- **The authoring gateway** — Phase 2 of [the requirements](docs/requirements.md), so that someone
  without a git host account can publish. Off unless `CMS_REPOSITORY` is set; with it set, every
  companion variable is required.
  - Authors are authenticated in one of two modes, chosen by `AUTH_MODE`: an OIDC bearer token
    verified against the issuer's key set, or the JWT an ALB running `authenticate-oidc` signs. The
    issuer, audience and claim names are configuration, because requirements Q3 and Q4 are still
    open. See [ADR 0013](docs/adr/0013-two-authentication-modes.md).
  - One GitHub App credential, minted on demand and cached, refreshed five minutes before expiry,
    single-flighted across concurrent callers, and invalidated once on an upstream 401. The private
    key comes from Secrets Manager and never reaches the image.
  - Editorial endpoints under `/v1/cms`: read the corpus on a branch, save and discard drafts,
    submit for review, and watch a submission's state. Saving creates or moves a branch and does not
    open a pull request. See [ADR 0014](docs/adr/0014-purpose-built-editorial-api.md).
  - Writes are confined to configured documentation prefixes and markdown extensions, reusing
    `kb/key-policy.ts` rather than restating its rules; branches are confined to `cms/*`, and the
    default branch is refused for every write. A change set with one bad entry is refused whole,
    before the first upstream call.
  - Commits carry the human as author and the App as committer, with a `Co-authored-by` trailer
    added exactly once even on retry. The pull request body names the submitter and their email.
  - One typed audit record per request, refusals at `warn` so alarms key on level. Request and
    response bodies are never logged.
  - A task that cannot authenticate to the git host refuses `/v1/cms/*` with `503 not_ready` from
    the gateway itself, and never becomes healthy in the new **editorial target group** — so a
    deploy in that state does not stabilise and ECS rolls it back. Readers are unaffected either
    way: the public target group still probes `/healthz`. The refusal is in the application rather
    than the load balancer because an ALB fails open when every target in a group is unhealthy,
    which is exactly the state a missing credential produces.
- **[The authoring gateway](docs/authoring-gateway.md)** — configuration, what is refused and why,
  and how to verify a deployment.
- `scripts/check/verify-gateway.ts` — drives a running gateway through the R1–R6, R9 and R10
  acceptance criteria and prints a pass/fail table. Phase 2's stated exit condition.
- New gateway variables: `CMS_REPOSITORY` (the master switch), `GITHUB_APP_ID`,
  `GITHUB_APP_INSTALLATION_ID`, `CMS_APP_SECRET_ARN` or `CMS_APP_PRIVATE_KEY_PATH`, `AUTH_MODE`,
  `AUTH_ISSUER_URL`, `AUTH_AUDIENCE`, `AUTH_ALB_ARN`, `AUTH_EMAIL_CLAIM`, `AUTH_NAME_CLAIM`,
  `CMS_DEFAULT_BRANCH`, `CMS_BRANCH_PREFIX`, `CMS_PATH_PREFIXES`, `POLICY_ALLOW_MERGE_FROM_CMS`,
  `GITHUB_API_BASE_URL`. New stack keys: `cmsAuthMode`, `cmsAuthIssuerUrl`, `cmsAuthAudience`,
  `cmsAuthEmailClaim`, `cmsAuthNameClaim`, `cmsBranchPrefix`, `cmsPathPrefixes`, `cmsAllowMerge`,
  and five `cmsOidc*` keys plus the secret `cmsOidcClientSecret` for `alb` mode.
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

- **`/v1` is terminated before the static site.** An unknown API path answered 200 with the site's
  HTML, because the site is a catch-all mounted last. It now answers JSON 404. This is a behaviour
  change for any client that was relying on the old response, and the reason it matters is
  [requirements R5](docs/requirements.md): "an unmatched method/path combination is refused and
  logged" is not true if the answer is a page.
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
