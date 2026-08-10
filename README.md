<h1 align="center">Lugem Knowledge Base</h1>

<p align="center">
  <em>Documentation that publishes itself and answers questions.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Bun-1.3-000000?style=flat-square&logo=bun" alt="Bun">
  <img src="https://img.shields.io/badge/TypeScript-6.0-blue?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Pulumi-3.256-8A3391?style=flat-square&logo=pulumi" alt="Pulumi">
  <img src="https://img.shields.io/badge/Docusaurus-3.10-25c2a0?style=flat-square&logo=docusaurus" alt="Docusaurus">
  <img src="https://img.shields.io/badge/AWS-ECS%20%7C%20Bedrock%20%7C%20S3-FF9900?style=flat-square&logo=amazon-aws" alt="AWS">
  <img src="https://img.shields.io/badge/Vitest-4.1-6E9F18?style=flat-square&logo=vitest" alt="Vitest">
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT">
</p>

Lugem KB keeps a documentation corpus in git, publishes it as a static site, and indexes the same
markdown into an Amazon Bedrock knowledge base — so readers can ask a question in plain language
and get passages back with citations to the page they came from.

This repository is the reference implementation: a Bun monorepo deployed to AWS by Pulumi, into a
VPC you already have.

## ✨ Features

- **One corpus, two consumers.** The markdown in `docs/` is published by the site and ingested by
  the knowledge base from the same commit. Nothing is duplicated, so the page and the answer
  cannot drift apart.
- **Grounded answers, or none at all.** Ask a question from any page and get a short answer
  streamed back with citations. Retrieval is the gate: when nothing clears the relevance threshold
  the answer model is never called, and the reader is told plainly — in a distinct response shape
  a client cannot render as an answer.
- **Deploys into your VPC.** No VPC is created. Subnet membership is verified during `pulumi
preview`, not discovered halfway through `up`.
- **A knowledge base you can afford to leave running.** S3 Vectors instead of OpenSearch
  Serverless — pay-per-use rather than roughly $700/month idle.
- **Publishing without a git account.** Authors reach GitHub through one App credential they never
  see, confined to `docs/` and `cms/*` branches, with their own name and email on every commit.
  Every refusal happens before the credential is used.
- **Fails closed.** A missing variable stops start-up naming the variable; a bad region stops the
  preview naming the config key.
- **Least privilege by construction.** The task role names one bucket, one prefix, one knowledge
  base ARN. No wildcards.

## 🚀 Quick start

Requires [Bun](https://bun.sh) 1.3.14+ and Node 24 (see `.bun-version` / `.nvmrc`).

```bash
git clone https://github.com/m-howard/lugem-kb.git
cd lugem-kb
bun install

bun run docs:start   # documentation site on http://localhost:3001
```

To run the service, which serves the built site alongside its API:

```bash
bun run docs:build
cp .env.example .env   # fill in CORPUS_BUCKET, KNOWLEDGE_BASE_ID and ANSWER_MODEL_ID
bun run dev
```

No AWS account yet? Run the whole thing — site and API, one process, one port — with AWS stubbed:

```bash
bun run docs:build
bun run scripts/dev/serve-e2e.ts   # http://127.0.0.1:4173
```

See [Getting started](docs/getting-started.md#working-on-the-ask-widget) for what's stubbed and
the hot-reload alternative.

Deploying needs the [Pulumi CLI](https://www.pulumi.com/docs/install/) **3.226.0+** — the `bun`
runtime landed in that release. See **[Deploying to AWS](docs/deploying-to-aws.md)** for the three
AWS account prerequisites before you run it.

## 🏗️ Architecture

```text
                        ┌──────────────────────────────┐
   reader ───▶ ALB ────▶│  ECS Fargate (private subnet)│
                        │  ┌────────────────────────┐  │
   author ───▶     ────▶│  │ Bun + Hono gateway     │  │
                        │  │  /healthz  /readyz     │  │
                        │  │  /v1/documents         │──┼──▶ S3 corpus bucket
                        │  │  /v1/search            │──┼──▶ Bedrock knowledge base
                        │  │  /v1/ask  (SSE)        │──┼──▶   └─▶ S3 Vectors index
                        │  │      └─ retrieve first │──┼──▶ Bedrock answer model
                        │  │  /v1/cms  (auth)       │──┼──▶ GitHub, as one App
                        │  │      └─ policy first   │  │      └─▶ cms/* branches only
                        │  │  /*  built Docusaurus  │  │
                        │  └────────────────────────┘  │
                        └──────────────────────────────┘
                                      ▲
   git push ──▶ CI ──▶ image build ───┘
            └──▶ scripts/docs/sync-corpus.ts ──▶ S3 corpus ──▶ Bedrock ingestion
```

The static site is a catch-all route, so it is mounted **last**. Getting that order wrong answers
every API path with HTML and a 200 status — health checks stay green and only a JSON client
notices — which is why there are tests for it at both the integration and e2e layers.

## 📁 Project structure

```text
apps/docs/         Docusaurus site. Content root is the repo-root docs/ tree.
apps/gateway/      Bun + Hono service. Serves the site and the API. Owns the Dockerfile.
infra/pulumi/      Pulumi program, runtime: bun. ECR, ECS, ALB, S3, Bedrock, and the
                   GitHub repository backing the corpus.
docs/              The corpus: guides, requirements, and ADRs.
scripts/docs/      sync-corpus.ts — upload markdown to S3 and trigger ingestion.
scripts/check/     verify-gateway.ts — drive a deployment through the R1–R10 acceptance list.
tests/e2e/         Playwright, against a real server and a real build.
```

## 💻 Usage

### Ask the corpus a question

Open the site and use **Ask the docs** on any page, or the `/ask` page. Over HTTP:

```bash
curl -N -X POST "$SITE_URL/v1/ask" \
  -H 'content-type: application/json' \
  -d '{"question":"how do I deploy into an existing VPC?"}'
```

Citations arrive first, so the sources are on screen before the prose is finished — and so
"every answer carries a citation" holds by construction rather than by hope:

```text
event: citations
data: [{"sourceUri":"s3://lugem-corpus/docs/adr/0006-deploy-into-an-existing-vpc.md",
        "url":"/adr/0006-deploy-into-an-existing-vpc","lastReviewed":"2026-08-09",
        "text":"The stack consumes an existing VPC and never creates one...","score":0.87}]

event: token
data: {"text":"The stack consumes an existing VPC and never creates one. [1]"}

event: done
data: {"ok":true}
```

When nothing is relevant enough there is no stream at all — the answer model is never called:

```json
{ "covered": false, "message": "No documentation covers this question." }
```

`POST /v1/search` still returns the raw passages, for a client that wants to do its own reading.

### Publish a change

```bash
# 1. edit or add a markdown file under docs/
# 2. open a pull request; CI builds the site and runs the suite
# 3. on merge, sync the corpus and reindex
bun run corpus:sync
```

### Publish a change without a git account

With the authoring gateway configured, an editor saves a draft and submits it for review over HTTP.
Both are refused before GitHub is touched if the path or the branch is not one the CMS owns:

```bash
curl -X PUT "$SITE_URL/v1/cms/drafts/cms/leave-policy" \
  -H "authorization: Bearer $ACCESS_TOKEN" -H 'content-type: application/json' \
  -d '{"files":[{"path":"docs/leave-policy.md","content":"# Leave\n"}]}'

curl -X POST "$SITE_URL/v1/cms/submissions" \
  -H "authorization: Bearer $ACCESS_TOKEN" -H 'content-type: application/json' \
  -d '{"branch":"cms/leave-policy","title":"Rewrite the leave policy"}'
```

The commit records the author from their token; the App remains the committer, because the App is
what performed the write. See **[The authoring gateway](docs/authoring-gateway.md)**.

`corpus:sync` also **deletes** objects whose source file is gone. A page removed from the
repository must stop being answerable, or the knowledge base keeps citing a page the site no
longer has.

## ⚙️ Configuration

Gateway environment (see `.env.example`; the service refuses to start if a required one is absent):

| Variable                    | Required | Default | Purpose                                                        |
| --------------------------- | -------- | ------- | -------------------------------------------------------------- |
| `AWS_REGION`                | yes      | —       | Region of the corpus bucket and knowledge base.                |
| `CORPUS_BUCKET`             | yes      | —       | S3 bucket holding the markdown.                                |
| `CORPUS_PREFIX`             | yes      | —       | Key prefix. Reads outside it are refused before any S3 call.   |
| `KNOWLEDGE_BASE_ID`         | yes      | —       | Bedrock knowledge base to retrieve from.                       |
| `ANSWER_MODEL_ID`           | yes      | —       | Bedrock model that writes answers. Needs model access granted. |
| `SITE_ROOT`                 | yes      | —       | Directory holding the built Docusaurus output.                 |
| `PORT`                      | no       | `3000`  | Listen port.                                                   |
| `LOG_LEVEL`                 | no       | `info`  | `fatal` … `trace`.                                             |
| `RETRIEVAL_SCORE_THRESHOLD` | no       | `0.4`   | Below this, no coverage — and no model call.                   |
| `ANSWER_MAX_TOKENS`         | no       | `700`   | Ceiling on answer length.                                      |
| `ASK_RATE_LIMIT_PER_MINUTE` | no       | `20`    | Questions per client per minute on `/v1/ask`.                  |

The authoring gateway is off unless `CMS_REPOSITORY` is set, and every companion variable is
required once it is. They are listed in `.env.example` and explained in
**[The authoring gateway](docs/authoring-gateway.md#configure-it)**.

Pulumi stack configuration is documented in
**[Deploying to AWS](docs/deploying-to-aws.md#configure-the-stack)**.

## 📖 Documentation

- **[Asking questions](docs/asking-questions.md)** — the reader's guide to the assistant.
- **[The authoring gateway](docs/authoring-gateway.md)** — publishing without a git host account.
- **[Getting started](docs/getting-started.md)** — run everything locally.
- **[Deploying to AWS](docs/deploying-to-aws.md)** — prerequisites, config, costs, teardown.
- **[The corpus repository](docs/corpus-repository.md)** — branch rules, the publish pipeline, and the CMS app credential.
- **[Architecture decision records](docs/adr/)** — why each piece is the way it is, and what it costs.
- **[Requirements](docs/requirements.md)** — the product this scaffold is the first phase of.

Notable decisions: [two authentication modes](docs/adr/0013-two-authentication-modes.md) ·
[a purpose-built editorial API](docs/adr/0014-purpose-built-editorial-api.md) ·
[grounded generation behind retrieval](docs/adr/0012-grounded-generation-behind-retrieval.md) ·
[Pulumi owns the corpus repository](docs/adr/0011-pulumi-owns-the-corpus-repository.md) ·
[custom components for resource groups](docs/adr/0010-custom-components-for-resource-groups.md) ·
[S3 Vectors over OpenSearch Serverless](docs/adr/0005-bedrock-knowledge-base-on-s3-vectors.md) ·
[Pulumi on the bun runtime](docs/adr/0004-pulumi-with-bun-runtime.md) ·
[one lockfile, no pnpm parity](docs/adr/0007-single-lockfile-no-pnpm-parity.md) ·
[serving the site from ECS](docs/adr/0003-serve-the-site-from-ecs.md) — and what that costs.

## 🧪 Development

```bash
bun run typecheck      # tsc across every workspace
bun run lint           # eslint
bun run lint:md        # markdownlint
bun run test           # unit + integration
bun run test:coverage  # the same, against the 80% gate
bun run test:e2e       # Playwright, real server and real build, AWS stubbed

bun run scripts/check/verify-gateway.ts --base-url http://127.0.0.1:3000
```

## 🤝 Contributing

See **[CONTRIBUTING.md](CONTRIBUTING.md)**. In short: conventional commits, and if you change code
under any `src/`, ship the tests in the same pull request.

Security issues go to **[SECURITY.md](SECURITY.md)**, not the public issue tracker.

## 📄 License

[MIT](LICENSE).

## ⚠️ Status

Phases 1, 2 and 5 of [the requirements](docs/requirements.md) are built.

- **Phase 1 — Foundation.** Corpus in git, site building, deployment stood up.
- **Phase 2 — Gateway.** Authentication, the GitHub App credential broker, the path, branch and
  endpoint policies, human attribution, audit records and fail-closed configuration — R1–R6, R9 and
  R10. Verify a deployment with `scripts/check/verify-gateway.ts`, which is the phase's stated exit
  condition.
- **Phase 5 — Answering.** Grounded generation with citations, a chat widget on every page, a
  `/ask` page, and the gap feedback loop: readers can mark an answer unhelpful, questions the
  corpus cannot answer are recorded, and a weekly job files them as a rolling GitHub issue naming
  the owning team — R20, R21, R23. R22 is built and switched off, see below.

**Not built yet:** Phase 3's pilot surface — Decap CMS at `/admin`, pull request previews and
content quality gates — and Phase 4's notifications. The editorial API is a purpose-built one, so
wiring a CMS to it needs an adapter; [ADR 0014](docs/adr/0014-purpose-built-editorial-api.md)
records that cost.

Three known gaps, each recorded where it belongs:

- **Reader authentication is built and off by default.** `/v1/ask` is unauthenticated unless
  `READER_AUTH_REQUIRED` is set, so R22's first criterion is not met on a default deployment and
  the rate limit remains a cost guard rather than access control. That is deliberate — turning it
  on puts a login in front of every reader and requires a certificate. See
  [ADR 0016](docs/adr/0016-reader-authentication.md).
- **ALB auth mode is not proven end to end.** It needs an HTTPS listener, a certificate and a
  registered identity provider application, none of which this stack has by default. Its verifiers
  are unit-tested and its listener rules — editorial and, now, reader — are preview-only. See
  [ADR 0013](docs/adr/0013-two-authentication-modes.md).
- **Conflicting pages are not verified.** R20 asks that two indexed pages that disagree are both
  surfaced. The prompt requires it and nothing checks that the model complies; closing it needs an
  evaluation fixture with two deliberately contradictory pages.

---

<p align="center">
  <em>Happy coding! 🚀</em>
</p>
