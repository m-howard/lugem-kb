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

The site alone cannot answer a question or save a draft, so **Ask** and **Publisher** need a
gateway behind them. The dev server proxies to one; the next section starts both.

## The whole stack in one command {#the-whole-stack-in-one-command}

`/v1/*` belongs to the gateway, and in production the gateway serves the site, so the two are one
origin. Locally they are two processes, and this starts both:

```bash
bun run dev:all      # then open http://127.0.0.1:3001
```

| What            | Port   | Notes                                                              |
| --------------- | ------ | ------------------------------------------------------------------ |
| Docusaurus      | `3001` | **Open this one.** Hot reload, with the gateway proxied behind it. |
| Sandbox gateway | `4300` | The API and `/publisher`, with AWS and the git host stubbed.       |

One origin, without a proxy in front: the dev server forwards `/v1/*`, `/healthz`, `/readyz`,
`/previews/` and `/idp/` to whichever gateway `dev:all` started, and answers everything else
itself. `GATEWAY_ORIGIN` is what points it at one — set it if you start the two by hand. Streaming
passes through untouched, and so does the hot-reload WebSocket.

Output is prefixed per process, and if either exits the other is stopped with it — a half-running
stack answers with an error that reads like a bug in whatever you were working on. `Ctrl-C` stops
everything.

| Flag        | Effect                                                                       |
| ----------- | ---------------------------------------------------------------------------- |
| `--gateway` | Run the real gateway on `3000` instead of the sandbox. Needs `.env` and AWS. |
| `--reset`   | Discard the sandbox's saved drafts and reseed from `docs/`.                  |

The sandbox is the default because it is the half that needs no account. For what it stubs and
what it does not, see [Run the CMS at `/publisher`](#run-the-cms-at-publisher).

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

| Method | Path                   | Purpose                                                            |
| ------ | ---------------------- | ------------------------------------------------------------------ |
| `GET`  | `/healthz`             | Liveness. Touches nothing upstream.                                |
| `GET`  | `/readyz`              | Readiness. Checks the corpus bucket.                               |
| `GET`  | `/v1/documents`        | List documents under the corpus prefix.                            |
| `GET`  | `/v1/documents/:path`  | Fetch one document.                                                |
| `POST` | `/v1/search`           | Retrieve passages with citations. Body: `{"question": "..."}`.     |
| `POST` | `/v1/ask`              | Grounded answer, streamed as SSE. Body: `{"question", "history"}`. |
| `*`    | `/v1/cms/*`            | The authoring gateway. Only mounted when `CMS_REPOSITORY` is set.  |
| `GET`  | `/v1/publisher/config` | Sign-in parameters for `/publisher`. Mounted with the CMS.         |
| `GET`  | `/*`                   | The built documentation site, including `/publisher/`.             |

`/v1/ask` answers in one of two shapes. A question the corpus covers gets `text/event-stream`: a
`citations` frame, then `token` frames, then `done`. A question it does not gets ordinary JSON —
`{"covered": false, ...}` — and no model is called to produce it.

Any other `/v1/...` path answers JSON `404`. The site is a catch-all mounted last, so without that
terminator a mistyped API path would return the site's HTML with a `200`.

## Run the CMS at `/publisher` {#run-the-cms-at-publisher}

```bash
bun run dev:cms      # http://127.0.0.1:4300/publisher/
```

That is the whole setup. No AWS account, no GitHub App, no identity provider, no `.env`. It signs
you in, lists this repository's own `docs/` pages as a collection, and lets you edit one, save it,
watch the draft reach the editorial board, and submit it for review.

The gateway itself is the real one — the same `createApp`, the same branch, path and endpoint
policies, real token verification. What is local is everything it talks to: a git host that keeps
what it is given, an identity provider on the same origin, and stubbed AWS. See
[ADR 0022](./adr/0022-a-local-sandbox-for-the-editorial-surface.md).

Drafts are written to `.lugem-local/cms-sandbox.json` and survive a restart, which is the point —
a page half-written today and finished tomorrow is the normal way documentation gets written. To
start over:

```bash
bun run dev:cms --reset
```

| Variable                                      | Default              | Why you would set it                                             |
| --------------------------------------------- | -------------------- | ---------------------------------------------------------------- |
| `PORT`                                        | `4300`               | Something else holds the port.                                   |
| `SITE_ROOT`                                   | `apps/docs/static`   | `apps/docs/build`, to get the whole site alongside `/publisher`. |
| `SANDBOX_AUTHOR_EMAIL`, `SANDBOX_AUTHOR_NAME` | a placeholder author | See your own name on the commits and pull requests.              |

`SITE_ROOT` points at `apps/docs/static` rather than a built site on purpose: Docusaurus copies
`static/` verbatim, so `/publisher/` resolves out of it and only the editor bundle has to be built,
which takes seconds. Every other path answers a plain-text 404 until you build the site.

The sandbox is loopback-only and is not a security boundary: its identity provider signs anyone in.

### Working on the editor itself, with hot reload

`apps/docs/src/publisher/` holds the sign-in shim. To iterate on it with the site rebuilding as you
type, one terminal:

```bash
bun run dev:all      # open http://127.0.0.1:3001/publisher/, or click Publisher in the navbar
```

That is [the whole stack](#the-whole-stack-in-one-command) — sandbox and Docusaurus — which is the
same two processes as:

```bash
bun run dev:cms                                        # sandbox gateway on :4300
GATEWAY_ORIGIN=http://127.0.0.1:4300 bun run docs:start # Docusaurus on :3001 — open this one
```

Sign-in works from either port, and from `localhost` or `127.0.0.1`. The sandbox publishes its
identity provider as a path (`/idp`) rather than a URL, so it resolves against whatever page is
asking — no environment variable has to name the door you came in by, and nothing is ever
cross-origin. The publisher page resolves what discovery gives it back into URLs before using them,
so a real provider's absolute endpoints work the same way.

### Against a real repository

Once the sandbox has taken you as far as it can — branch protection, real reviewers, a real
identity provider — see
**[The authoring gateway](./authoring-gateway.md#run-it-locally)** for the variables and what each
refusal means.

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

**With hot reload**, for iterating on the component itself. One terminal:

```bash
bun run dev:all              # against the sandbox gateway, no credentials
bun run dev:all --gateway    # against the real gateway, which needs .env
```

Or the same two processes by hand, in two terminals:

```bash
bun run dev            # gateway on :3000
bun run docs:start     # Docusaurus on :3001 — open this one
```

`docs:start` proxies the gateway's paths to `http://127.0.0.1:3000` unless `GATEWAY_ORIGIN` says
otherwise, so the browser sees a single origin. Streaming passes through untouched.

One origin rather than CORS on purpose: there is no CORS anywhere in this repository, and adding it
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

To check a _running_ gateway rather than the code, drive it through the authoring gateway's
acceptance list:

```bash
bun run scripts/check/verify-gateway.ts --base-url http://127.0.0.1:3000 --token "$ACCESS_TOKEN"
```

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

**The widget says it cannot reach the assistant, or Publisher says the gateway is not answering.**
Same cause: the dev server proxies `/v1/*` to a gateway, and there is no gateway to proxy to — or
it is on a port `GATEWAY_ORIGIN` does not name. `bun run dev:all` starts both together.

**`docs:build` fails on a broken link.** `onBrokenLinks` is set to `throw` on purpose — a broken
link in the corpus becomes a broken citation once the page is indexed.
