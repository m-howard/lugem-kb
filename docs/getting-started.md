---
title: Getting started
sidebar_position: 3
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

Docusaurus serves on `http://localhost:3001` with hot reload. Its content root is the repo-root
`docs/` directory, so editing any file in there updates the site immediately.

Port 3001, not 3000, because the gateway wants 3000 and the two need to run side by side — see
[working on the ask widget](#working-on-the-ask-widget).

## Run the gateway

The gateway serves the built site alongside its API, so build the site first:

```bash
bun run docs:build
cp .env.example .env      # then fill in CORPUS_BUCKET, KNOWLEDGE_BASE_ID and ANSWER_MODEL_ID
bun run dev
```

The service refuses to start if any required variable is missing, naming the one to fix. That is
deliberate — see [ADR 0009](./adr/0009-fail-closed-configuration.md).

Without AWS credentials the site and `/healthz` work; `/readyz`, `/v1/documents`, `/v1/search` and
`/v1/ask` need a real bucket, knowledge base and model access.

### Endpoints

| Method | Path                  | Purpose                                                            |
| ------ | --------------------- | ------------------------------------------------------------------ |
| `GET`  | `/healthz`            | Liveness. Touches nothing upstream.                                |
| `GET`  | `/readyz`             | Readiness. Checks the corpus bucket.                               |
| `GET`  | `/v1/documents`       | List documents under the corpus prefix.                            |
| `GET`  | `/v1/documents/:path` | Fetch one document.                                                |
| `POST` | `/v1/search`          | Retrieve passages with citations. Body: `{"question": "..."}`.     |
| `POST` | `/v1/ask`             | Grounded answer, streamed as SSE. Body: `{"question", "history"}`. |
| `GET`  | `/*`                  | The built documentation site.                                      |

`/v1/ask` answers in one of two shapes. A question the corpus covers gets `text/event-stream`: a
`citations` frame, then `token` frames, then `done`. A question it does not gets ordinary JSON —
`{"covered": false, ...}` — and no model is called to produce it.

## Working on the ask widget

The widget calls `/v1/ask` as a relative path, because in production the gateway serves the site
and the two are one origin. Locally they are two processes, so there are two ways to run them.

**Against the real thing.** No hot reload, but byte-for-byte the production request path:

```bash
bun run docs:build
bun run scripts/dev/serve-e2e.ts   # http://127.0.0.1:4173, AWS stubbed
```

This is the same harness Playwright drives. It needs no AWS credentials and no `.env`, and the
stubbed assistant answers anything except questions mentioning unicorns, which return the
no-coverage response so you can see that state too.

**With hot reload**, for iterating on the component itself. Three terminals:

```bash
bun run dev                          # gateway on :3000
bun run docs:start                   # Docusaurus on :3001
bun run scripts/dev/serve-dev.ts     # proxy on :4000 — open this one
```

The proxy forwards `/v1/*`, `/healthz` and `/readyz` to the gateway and everything else to
Docusaurus, so the browser sees a single origin. Streaming passes through untouched. Docusaurus's
hot-reload WebSocket does not, so edits rebuild but the page needs a manual refresh; the console
logs a WebSocket error, which is expected.

A proxy rather than CORS on purpose: there is no CORS anywhere in this repository, and adding it
would put a permanent production surface in place to solve a local problem.

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

**Port 3000 is already in use.** The gateway and Docusaurus both used to want it. `docs:start` now
binds 3001; if something else holds 3000, set `PORT` for the gateway.

**The widget says it cannot reach the assistant.** You are probably on `:3001` directly, where
`/v1/ask` is served by Docusaurus and 404s. Use the proxy on `:4000`, or the built site on `:4173`.

**`docs:build` fails on a broken link.** `onBrokenLinks` is set to `throw` on purpose — a broken
link in the corpus becomes a broken citation once the page is indexed.
