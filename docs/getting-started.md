---
title: Getting started
sidebar_position: 2
owner: platform
last_reviewed: 2026-08-09
---

# Getting started

Run the documentation site and the gateway on your own machine. Nothing here needs an AWS account —
for deployment, see [Deploying to AWS](./deploying-to-aws.md).

## Prerequisites

| Tool                                               | Version                      | Why                                                                                        |
| -------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------ |
| [Bun](https://bun.sh)                              | 1.3.14+ (see `.bun-version`) | Package manager, test runner, and the runtime for both the service and the Pulumi program. |
| Node.js                                            | 24 LTS (see `.nvmrc`)        | Docusaurus and some tooling still shell out to Node.                                       |
| Docker                                             | any recent                   | Only needed to build the container image.                                                  |
| [Pulumi CLI](https://www.pulumi.com/docs/install/) | **3.226.0+**                 | Only needed to deploy. The `bun` runtime landed in 3.226.0.                                |

## Install

```bash
git clone https://github.com/m-howard/lugem-kb.git
cd lugem-kb
bun install
```

## Run the site

```bash
bun run docs:start
```

Docusaurus serves on `http://localhost:3000` with hot reload. Its content root is the repo-root
`docs/` directory, so editing any file in there updates the site immediately.

## Run the gateway

The gateway serves the built site alongside its API, so build the site first:

```bash
bun run docs:build
cp .env.example .env      # then fill in CORPUS_BUCKET and KNOWLEDGE_BASE_ID
bun run dev
```

The service refuses to start if any required variable is missing, naming the one to fix. That is
deliberate — see [ADR 0009](./adr/0009-fail-closed-configuration.md).

Without AWS credentials the site and `/healthz` work; `/readyz`, `/v1/documents` and `/v1/search`
need a real bucket and knowledge base.

### Endpoints

| Method | Path                  | Purpose                                                        |
| ------ | --------------------- | -------------------------------------------------------------- |
| `GET`  | `/healthz`            | Liveness. Touches nothing upstream.                            |
| `GET`  | `/readyz`             | Readiness. Checks the corpus bucket.                           |
| `GET`  | `/v1/documents`       | List documents under the corpus prefix.                        |
| `GET`  | `/v1/documents/:path` | Fetch one document.                                            |
| `POST` | `/v1/search`          | Retrieve passages with citations. Body: `{"question": "..."}`. |
| `GET`  | `/*`                  | The built documentation site.                                  |

## Checks

```bash
bun run typecheck      # tsc across every workspace
bun run lint           # eslint
bun run lint:md        # markdownlint
bun run test           # unit + integration
bun run test:coverage  # the same, against the 80% gate
bun run test:e2e       # Playwright against a real server and a real build
```

`test:e2e` builds the site and boots the gateway itself, with AWS stubbed — no credentials needed.

## Adding a page

Create a markdown file anywhere under `docs/` with frontmatter:

```markdown
---
title: How to request leave
owner: people-ops
last_reviewed: 2026-08-09
---

# How to request leave
```

The sidebar is generated from the directory structure, so a new file appears without editing a
navigation config. `owner` routes review; `last_reviewed` is shown to readers next to citations so
staleness is as visible in an answer as it is on the page.

## Troubleshooting

**`bun run dev` exits immediately with a message about a variable.** That is the fail-closed
config working. Set the named variable in `.env`.

**The gateway serves the site but `/v1/documents` returns HTML.** The static handler is being
matched before the API. It must stay mounted last in `apps/gateway/src/app.ts`; the tests in
`apps/gateway/tests/integration/route-precedence.test.ts` cover this.

**`docs:build` fails on a broken link.** `onBrokenLinks` is set to `throw` on purpose — a broken
link in the corpus becomes a broken citation once the page is indexed.
