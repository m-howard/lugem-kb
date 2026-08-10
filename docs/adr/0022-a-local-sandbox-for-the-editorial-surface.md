---
title: 0022 — A local sandbox for the editorial surface
sidebar_label: 0022 Local CMS sandbox
owner: platform
last_reviewed: 2026-08-10
---

# ADR 0022 — A local sandbox for the editorial surface

- **Date:** 2026-08-10
- **Status:** Accepted

## Context

The `/admin` editor was, until now, the one part of this system nobody could run on their own
machine.

That follows from decisions made deliberately elsewhere.
[ADR 0009](./0009-fail-closed-configuration.md) makes configuration fail closed, and
`CMS_REPOSITORY` is a master switch: setting it makes a GitHub App id, an installation id, a
private key and an entire [auth block](./0013-two-authentication-modes.md) required, and leaving it
unset means `/v1/cms/*` and `/v1/admin/config` are never mounted at all. The bearer verifier
discovers its key set from a live `AUTH_ISSUER_URL`. So to open `/admin` you needed a real GitHub
App installed on a real repository _and_ a reachable identity provider — before writing a line of
code.

There was one credential-free path, `scripts/dev/serve-e2e.ts`, and it was built for Playwright
rather than for people. It hardcodes its fixtures, needs a full `docs:build` first, and its git
host — `tests/helpers/fake-github.ts` — is a **stateless route table**. `POST /git/blobs` always
answers `blob-written`, and the next read returns the same fixed tree. You could watch the editor
render. You could not save a page and see it come back.

The same gap showed up in the tests. `cms.test.ts` and `decap-proxy.test.ts` are thorough, but a
declared route table cannot assert a round trip: the read that follows a write is a different
fixture from the write, so "the page I saved is there" was not something any test said.

## Decision

### A stateful git host, not a second route table

`apps/gateway/tests/helpers/git-repo.ts` models the objects — blobs, flat trees, commits, branch
refs and pull requests — and `fake-git-host.ts` puts the allowlisted HTTP surface over it. Shas are
content-addressed, so an unchanged save produces an unchanged sha, as git does.

Scope is bounded by something that already exists: `git/endpoint-policy.ts` is a hard allowlist of
sixteen calls, so the surface to implement is closed and small. Anything outside it is refused
before a socket opens, and answers `404` here.

One piece of behaviour is not a shortcut and had to be modelled properly. `PATCH /git/refs/heads/*`
refuses a non-fast-forward, which is what produces the `409` an author reads as _"this draft moved
since you opened it"_. A fake that always accepted the update would make that path unreachable —
both in tests and by hand — for the one failure authors actually hit.

`fake-github.ts` stays. The two answer different questions, and both are worth asking: the route
table proves _which_ upstream calls a route makes, which is how the endpoint allowlist is guarded;
the repository proves the workflow works.

### The sandbox composes `CmsDependencies` directly

`createCmsDependencies` builds its own `GitHubClient` and `InstallationTokenSource` with no `fetch`
seam. It stays that way. Adding one would put a knob in production wiring that only development
turns, and `tests/helpers/e2e-cms.ts` had already established the alternative: compose the same
services over the same policies, injecting the collaborators.

What is **not** faked matters as much. The verifier is the production `createBearerVerifier` over a
local key set, so signatures are genuinely checked and the 401 paths behave locally as deployed.
The app is the production `createApp`, so route order — the thing that quietly breaks — is the
deployed one.

### No `AUTH_MODE=stub`, and no dev branch in `config.ts`

The obvious alternative was a development mode inside the service. It was rejected: it would put a
code path into the deployed artefact whose entire purpose is to skip authentication, one
misconfiguration away from being reachable in production. ADR 0009's fail-closed configuration
survives intact because nothing about the sandbox is expressible as configuration — it is a
different composition root, in `scripts/dev/`, that a deployment never loads.

### State on disk

The repository is written to `.lugem-local/cms-sandbox.json`, gitignored, through a temporary file
and a rename. A page half-written on Monday and finished on Tuesday is how documentation actually
gets written; a sandbox that forgot every restart would be a demo rather than somewhere to work.
`--reset` deletes it.

### `SITE_ROOT` defaults to `apps/docs/static`

Docusaurus copies `static/` verbatim, so `/admin/` resolves out of it directly and only the editor
bundle has to be built first — seconds, rather than a full site build. `createSiteRoutes` answers a
plain-text 404 for everything else, which is the right trade when the editor is what you came for.
Point `SITE_ROOT` at `apps/docs/build` to get the whole site.

## Consequences

- **`/admin` is runnable with one command.** `bun run dev:cms`, no accounts, no `.env`. Sign in,
  edit a page, save, watch it reach the editorial board, submit it for review.
- **The editorial round trip is tested.** `tests/integration/editorial-round-trip.test.ts` asserts
  save-then-read, the conflict refusal, the board, submission and merge — none of which a canned
  route table can express.
- **The sandbox is not a security boundary.** Its identity provider signs anyone in and its git
  host mints a token for any signature. It listens on loopback and belongs nowhere else.
- **Two fakes to keep working.** `fake-github.ts` and `fake-git-host.ts` both model the same
  upstream. That is the cost of keeping the allowlist assertions; the endpoint allowlist is the
  shared definition they are both written against.
- **The sandbox skips `loadConfig`.** It composes dependencies directly, so configuration parsing
  and `createCmsDependencies` are covered by their own unit tests rather than by running this. A
  mistake in the CMS config block still shows up at start-up, not here.
- **Not a substitute for a real repository.** Branch protection, review, merge conflicts between
  people and anything GitHub decides are outside the model. Before a deployment carries authors,
  `scripts/check/verify-gateway.ts` still runs against the real thing.

## Related

- [ADR 0009 — fail-closed configuration](./0009-fail-closed-configuration.md)
- [ADR 0013 — two authentication modes](./0013-two-authentication-modes.md)
- [ADR 0014 — a purpose-built editorial API](./0014-purpose-built-editorial-api.md)
- [ADR 0015 — the Decap adapter runs in the gateway](./0015-decap-adapter-in-the-gateway.md)
- [ADR 0021 — images travel with the draft](./0021-images-travel-with-the-draft.md)
- [Getting started](../getting-started.md) — how to run it
