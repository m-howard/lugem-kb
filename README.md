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
- **Retrieval with citations, never synthesis.** `POST /v1/search` returns the passages it found
  and where they came from. When nothing clears the relevance threshold it says so, in a distinct
  response shape a client cannot render as an answer.
- **Deploys into your VPC.** No VPC is created. Subnet membership is verified during `pulumi
preview`, not discovered halfway through `up`.
- **A knowledge base you can afford to leave running.** S3 Vectors instead of OpenSearch
  Serverless — pay-per-use rather than roughly $700/month idle.
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

bun run docs:start   # documentation site on http://localhost:3000
```

To run the service, which serves the built site alongside its API:

```bash
bun run docs:build
cp .env.example .env   # fill in CORPUS_BUCKET and KNOWLEDGE_BASE_ID
bun run dev
```

Deploying needs the [Pulumi CLI](https://www.pulumi.com/docs/install/) **3.226.0+** — the `bun`
runtime landed in that release. See **[Deploying to AWS](docs/deploying-to-aws.md)** for the two
AWS account prerequisites before you run it.

## 🏗️ Architecture

```text
                        ┌──────────────────────────────┐
   reader ───▶ ALB ────▶│  ECS Fargate (private subnet)│
                        │  ┌────────────────────────┐  │
                        │  │ Bun + Hono gateway     │  │
                        │  │  /healthz  /readyz     │  │
                        │  │  /v1/documents         │──┼──▶ S3 corpus bucket
                        │  │  /v1/search            │──┼──▶ Bedrock knowledge base
                        │  │  /*  built Docusaurus  │  │        └─▶ S3 Vectors index
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
infra/pulumi/      Pulumi program, runtime: bun. ECR, ECS, ALB, S3, Bedrock.
docs/              The corpus: guides, requirements, and ADRs.
scripts/docs/      sync-corpus.ts — upload markdown to S3 and trigger ingestion.
tests/e2e/         Playwright, against a real server and a real build.
```

## 💻 Usage

### Ask the corpus a question

```bash
curl -X POST "$SITE_URL/v1/search" \
  -H 'content-type: application/json' \
  -d '{"question":"how do I deploy into an existing VPC?"}'
```

```json
{
  "covered": true,
  "citations": [
    {
      "sourceUri": "s3://lugem-corpus/docs/adr/0006-deploy-into-an-existing-vpc.md",
      "text": "The stack consumes an existing VPC and never creates one...",
      "score": 0.87
    }
  ]
}
```

When nothing is relevant enough:

```json
{ "covered": false, "message": "No documentation covers this question." }
```

### Publish a change

```bash
# 1. edit or add a markdown file under docs/
# 2. open a pull request; CI builds the site and runs the suite
# 3. on merge, sync the corpus and reindex
bun run corpus:sync
```

`corpus:sync` also **deletes** objects whose source file is gone. A page removed from the
repository must stop being answerable, or the knowledge base keeps citing a page the site no
longer has.

## ⚙️ Configuration

Gateway environment (see `.env.example`; the service refuses to start if a required one is absent):

| Variable                    | Required | Default | Purpose                                                      |
| --------------------------- | -------- | ------- | ------------------------------------------------------------ |
| `AWS_REGION`                | yes      | —       | Region of the corpus bucket and knowledge base.              |
| `CORPUS_BUCKET`             | yes      | —       | S3 bucket holding the markdown.                              |
| `CORPUS_PREFIX`             | yes      | —       | Key prefix. Reads outside it are refused before any S3 call. |
| `KNOWLEDGE_BASE_ID`         | yes      | —       | Bedrock knowledge base to retrieve from.                     |
| `SITE_ROOT`                 | yes      | —       | Directory holding the built Docusaurus output.               |
| `PORT`                      | no       | `3000`  | Listen port.                                                 |
| `LOG_LEVEL`                 | no       | `info`  | `fatal` … `trace`.                                           |
| `RETRIEVAL_SCORE_THRESHOLD` | no       | `0.4`   | Below this, the API reports no coverage.                     |

Pulumi stack configuration is documented in
**[Deploying to AWS](docs/deploying-to-aws.md#configure-the-stack)**.

## 📖 Documentation

- **[Getting started](docs/getting-started.md)** — run everything locally.
- **[Deploying to AWS](docs/deploying-to-aws.md)** — prerequisites, config, costs, teardown.
- **[Architecture decision records](docs/adr/)** — why each piece is the way it is, and what it costs.
- **[Requirements](docs/requirements.md)** — the product this scaffold is the first phase of.

Notable decisions: [S3 Vectors over OpenSearch Serverless](docs/adr/0005-bedrock-knowledge-base-on-s3-vectors.md) ·
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
```

## 🤝 Contributing

See **[CONTRIBUTING.md](CONTRIBUTING.md)**. In short: conventional commits, and if you change code
under any `src/`, ship the tests in the same pull request.

Security issues go to **[SECURITY.md](SECURITY.md)**, not the public issue tracker.

## 📄 License

[MIT](LICENSE).

## ⚠️ Status

This is Phase 1 of [the requirements](docs/requirements.md) — corpus in git, site building,
deployment stood up — plus a working retrieval slice of Phase 5. The authoring gateway (Decap CMS,
the GitHub App credential broker, the branch and endpoint policy engine) is **not built yet**, and
answer _generation_ is deliberately out of scope: retrieval with citations ships, synthesis does
not.

---

<p align="center">
  <em>Happy coding! 🚀</em>
</p>
