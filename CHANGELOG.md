# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **A local sandbox for `/admin`** — `bun run dev:cms` runs the editorial surface with no AWS
  account, no GitHub App and no identity provider. See
  [ADR 0022](docs/adr/0022-a-local-sandbox-for-the-editorial-surface.md).
  - Until now `/admin` was the one part of the system nobody could run locally: `CMS_REPOSITORY` is
    a master switch that makes an App credential and a reachable OIDC issuer required, and the only
    credential-free path stubbed the git host with a table of canned responses — you could watch
    the editor render, but not save a page and see it come back.
  - `apps/gateway/tests/helpers/git-repo.ts` models the objects instead — blobs, trees, commits,
    refs and pull requests, content-addressed — and `fake-git-host.ts` serves the sixteen calls
    `git/endpoint-policy.ts` allows. Non-fast-forward ref updates are refused properly, so the
    `409` an author reads as "this draft moved since you opened it" is reachable by hand.
  - The gateway is the production one: the same `createApp`, the same branch, path and endpoint
    policies, and the real `createBearerVerifier` over a local key set, so the 401 paths behave as
    deployed. There is no `AUTH_MODE=stub` and no development branch in `config.ts` — the sandbox
    is a separate composition root under `scripts/dev/`, which a deployment never loads.
  - Seeded from this repository's own `docs/` tree, so the collection holds real pages in the real
    frontmatter shape. Drafts and pull requests are persisted to a gitignored
    `.lugem-local/cms-sandbox.json` and survive a restart; `--reset` starts over.
  - `SITE_ROOT` defaults to `apps/docs/static`, so only the editor bundle has to be built rather
    than the whole site.
  - `bun run dev:proxy` now forwards `/idp/` and `/previews/` as well, and the sandbox takes
    `PUBLIC_ORIGIN`, so the editor can be worked on behind the proxy with Docusaurus hot-reloading.
- **The editorial round trip is tested** — `tests/integration/editorial-round-trip.test.ts` drives
  save, re-read, conflict, the editorial board, submission and merge against the stateful host.
  `cms.test.ts` and `decap-proxy.test.ts` keep their canned route tables, which is what proves
  _which_ upstream calls the gateway makes; neither could assert that a saved page comes back,
  because with a table the read is a different fixture from the write.
- **Image handling in the CMS** — R15, so an author illustrates a page themselves instead of filing
  a ticket for an engineer to commit a PNG. See
  [ADR 0021](docs/adr/0021-images-travel-with-the-draft.md).
  - An image added while a page is open is committed to that page's draft branch **in the same
    commit as the markdown**, so R15 adds no write path: the image is submitted, reviewed and
    published exactly as the words around it are. Decap's own git backends commit media straight to
    the default branch, which branch policy and R8's branch protection both refuse here — so the
    standalone media-library upload is refused with somewhere better to go.
  - Uploads are confined to one folder, `CMS_MEDIA_FOLDER`, defaulting to `docs/assets/media/`.
    Narrower than `CMS_PATH_PREFIXES` on purpose: those say where _pages_ may be written, and an
    image is not a page. The gateway refuses to start if the folder falls outside them, and
    `pulumi preview` fails on the same rule.
  - `apps/docs` publishes `docs/assets/` as a static directory, so an upload is served from the
    site root under its folder's own name — `/media/org-chart.png`. The gateway derives that public
    path from the folder rather than taking it as a second setting. A missing image then fails the
    Docusaurus build with its file and line, which is the guarantee R13 gives links, obtained
    without adding a check.
  - PNG, JPEG, GIF and WebP only, and the leading bytes of every file are checked against its
    extension. **No SVG:** it can carry a script, and the site shares an origin with `/admin`, where
    the author's token lives in `sessionStorage`.
  - `CMS_MAX_UPLOAD_BYTES` defaults to 2 MiB. An oversized image is answered `413` with a message
    naming the file and both sizes, and **nothing is written** — one bad image refuses the whole
    save, as R3 already requires of one bad path. The proxy endpoint's request-body limit is derived
    from the same number, so a save dropped by the middleware gets the same explanation.
  - The editorial board reports images as changed files alongside pages, because Decap derives an
    entry's media from that list — without it an uploaded screenshot would vanish from the editor on
    reload while sitting on the branch all along.
  - Nothing under the media folder is synced to S3 or indexed: `scripts/docs/corpus-files.ts` walks
    markdown only, so R21 is untouched.
- **Pull request previews** — R12, so an author sees their page rendered before anybody approves
  it, and a reviewer reads the change rather than the diff.
  - The gateway serves `/previews/pr-<number>/` from a private S3 bucket, behind whatever already
    guards the documentation site. Not a CloudFront distribution: a preview renders unmerged
    changes to a corpus holding people and finance content, and a public URL in front of that is a
    second authentication story to build. See
    [ADR 0018](docs/adr/0018-previews-behind-the-gateway.md).
  - A bucket of its own, never the corpus bucket, so R21's "preview builds are never ingested" is
    true by construction rather than resting on a prefix filter somebody could edit.
  - `.github/workflows/preview.yml` builds with `DOCUSAURUS_BASE_URL=/previews/pr-<n>/`, syncs with
    `--delete`, and comments the link. On `closed` — merged or abandoned — it deletes the prefix and
    rewrites the comment. A 30-day lifecycle rule is the backstop, not the mechanism.
  - Decap's `getDeployPreview` is answered from the entry's newest submission, so the link appears
    on the workflow card without anything telling the CMS what the workflow did.
  - `resolvePreviewRequest` refuses any path that could resolve outside the requested pull
    request's prefix before any S3 call, mirroring `kb/key-policy.ts`. Pure, and its whole refusal
    table is a unit test.
  - Off unless `PREVIEW_BUCKET` is set, and `PREVIEW_BASE_URL` becomes required with it.
- **Content quality gates** — R13, run as their own CI job and reported where an author will see
  them. `bun run docs:check`.
  - Frontmatter must carry `title`, `owner` and a real `last_reviewed` calendar date; every page
    must match a `CODEOWNERS` entry, reusing the same matcher the gap report uses; every relative
    markdown link and `#anchor` must resolve.
  - Failures arrive as `::error` annotations pinned to the line in the diff and as a table posted
    on the pull request, updated in place on each push and corrected when the problems are fixed.
    That is the criterion the Docusaurus build could not meet — it already fails on a broken link,
    but a stack trace in an Actions log is not a message an author who has never seen this
    repository can act on. See [ADR 0019](docs/adr/0019-content-quality-gates.md).
- **The documentation CMS at `/admin`** — the CMS half of Phase 3, so an author writes and submits
  a page without a git host account or any knowledge of markdown. See
  [Editing in the CMS](docs/editing-in-the-cms.md).
  - Decap CMS reaches the editorial API through an adapter in the gateway at `POST /v1/cms/proxy`.
    Every action goes through the same document, draft and submission services the REST routes use,
    so the path, branch and endpoint policies apply unchanged and a refusal still costs no upstream
    call. See [ADR 0015](docs/adr/0015-decap-adapter-in-the-gateway.md).
  - Decap's three editorial statuses map onto the gateway's two states: a draft is a `cms/*` branch
    with no pull request, submitting opens one, and `pending_publish` is an alias rather than a
    third state — publishing stays in the git host, where a code owner approves it.
  - The endpoint allowlist gained one read-only row, `GET /git/matching-refs/heads/...`, because
    the editorial board has to show drafts that have no pull request yet.
  - `SubmissionService.close` withdraws a submission without touching its branch, reusing the same
    confinement check as merge so an author cannot close a pull request that is not theirs.
  - The `/admin` page runs its own OIDC sign-in with PKCE, because Decap's proxy backend sends no
    `Authorization` header. `AUTH_CLIENT_ID` (stack key `cmsAuthClientId`) is required in `bearer`
    mode; `GET /v1/admin/config` publishes the sign-in parameters anonymously, since they travel in
    the browser's redirect URL regardless.
  - Audit records carry the Decap action, so one endpoint carrying every operation still leaves a
    log an operator can read (R9).
  - Image upload was not supported at first: the corpus held markdown only, so the media library
    listed nothing and uploads were refused with an explanation. Added since — see R15 above.
- **The gap feedback loop** — Phase 5 of [the requirements](docs/requirements.md), so the
  documentation learns what it is missing. Off unless `GAP_FEEDBACK_TABLE` is set.
  - A question the corpus cannot answer is recorded, and readers can mark an answer unhelpful with
    an optional reason. An answered question is never recorded, and no record carries who asked.
  - Retention is a per-item DynamoDB TTL, defaulting to ninety days, rather than a policy someone
    has to remember. This settles open question Q11 — see
    [ADR 0016](docs/adr/0016-recording-documentation-gaps.md).
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
  [ADR 0017](docs/adr/0017-reader-authentication.md).

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
- **The gateway's container contract is resolved by name, not by position.** `GatewayService` built
  its environment and its task policy from `pulumi.all([...])` tuples destructured positionally,
  with a comment warning that inserting a value anywhere but the end shifts every later binding.
  `allStrings` keeps the names, and has no eight-value ceiling.
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

### Fixed

- **`/admin` without a trailing slash sat on "Signing you in…" forever.** The site handler answers
  a directory route at both spellings, but only redirected at neither — so `/admin` returned the
  editor's `index.html` while the browser resolved its relative `./admin.js` against `/`, asking
  for `/admin.js` and getting a 404. The bundle never ran, and because the "Signing you in…" text
  is the static placeholder the script replaces, the page reported nothing: the only evidence was
  a 404 in a console the author had no reason to open. A slashless path that resolves to a
  directory with an `index.html` now answers `301` to the canonical form, query string intact so
  an OIDC callback landing there keeps its `code` and `state`. This applies to every directory
  route, not just `/admin`.

- **`bun run docs:build` failed on a clean clone.** `apps/docs/package.json` runs
  `scripts/build/build-admin.ts` as its `prebuild` hook, and that file had never been committed:
  `.gitignore`'s bare `build/` pattern matches `scripts/build/` as well as the Docusaurus and
  container output, so `git add` reported nothing and the file was only ever on one machine. CI's
  **Build** and **E2E** jobs were failing on `main` as a result, and no preview could have been
  built at all. The bundler is restored, and all three ignore files — `.gitignore`,
  `.prettierignore` and `eslint.config.mjs` — now un-ignore `scripts/build/` explicitly.

### Removed

- Stale `spec/` entries from `.prettierignore` and `.markdownlintignore` — no such tree exists.

[Unreleased]: https://github.com/m-howard/lugem-kb/commits/main
