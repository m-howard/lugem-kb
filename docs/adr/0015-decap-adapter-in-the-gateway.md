---
title: 0015 — The Decap adapter runs in the gateway
sidebar_label: 0015 Decap adapter
owner: platform
last_reviewed: 2026-08-10
---

# ADR 0015 — The Decap adapter runs in the gateway

- **Date:** 2026-08-10
- **Status:** Accepted

## Context

[ADR 0014](./0014-purpose-built-editorial-api.md) chose a purpose-built editorial API over a
git-host proxy, and recorded the bill it left behind:

> **Phase 3 costs more.** Decap cannot be pointed at this API with configuration; it needs an
> adapter — its `proxy` backend protocol is the closest fit. That is the real price of this
> decision, and it is paid by the phase that adds the CMS rather than by this one.

This is that phase paying it. Decap's `proxy` backend posts `{action, params}` to a single URL and
expects answers in shapes its own core defines. The gateway speaks REST over `/v1/cms/*`. Something
has to translate, and the only real question is where.

## Decision

The adapter is **server-side**, at `POST /v1/cms/proxy`, mounted inside the existing editorial
sub-app.

Every action goes through the same `DocumentReader`, `DraftService` and `SubmissionService` the
REST routes use. That is the property worth protecting: the protocol changes, the policies do not.
A write outside `docs/`, a branch outside `cms/`, a merge with the flag unset — each is refused by
the same code, before the credential is used, whichever surface asked.

Mounting it _inside_ `/v1/cms` rather than beside it means it inherits authentication and the
credential guard. An adapter mounted separately would be one refactor away from being reachable
without a token.

### Why not in the browser

A browser-side backend was the obvious alternative — Decap supports `registerBackend`. It was
rejected on testability. `vitest.config.mts` has no jsdom project, so adapter logic in the browser
would be covered by nothing but Playwright, while the same logic in TypeScript on the server is
covered by the existing unit and integration idiom and counts against the 80% gate.

The `/admin` page still ships browser code, but only the parts that must be there: an OIDC sign-in,
and a `fetch` wrapper. Everything with a decision in it is pure and unit-tested.

### The status model

Decap's editorial workflow has three columns. The gateway has two states, and they are the two the
save/submit split already made:

| Decap status      | Gateway state                          | Transition                  |
| ----------------- | -------------------------------------- | --------------------------- |
| `draft`           | a `cms/*` branch, no open pull request | `DraftService.save`         |
| `pending_review`  | an open pull request                   | `SubmissionService.submit`  |
| `pending_publish` | an open pull request (alias)           | accepted, not distinguished |

This preserves [requirements](../requirements.md) R7 — **"saving a draft creates or updates a branch
and does not open a pull request"** — without special-casing anything, because Decap's own split
happens to be the gateway's.

`pending_publish` is an alias rather than a refusal so the board does not error. The consequence is
visible: a card dragged to the third column reads back in the second. The alternative was a label
API the endpoint allowlist does not admit, to represent a state that means nothing here —
publishing is not a CMS action, because R7 and R8 put approval in the git host.

`publishUnpublishedEntry` maps to `SubmissionService.merge`, which is refused by default. An author
who tries it is told that publishing happens in GitHub.

### One policy widening

The allowlist gained a single row: `GET /git/matching-refs/heads/...`. The editorial board must
show drafts that have no pull request yet, and such a draft is only a branch — there is nothing
else to ask about. Without it an author saves a draft, reloads, and it has vanished.

It is read-only, the pattern requires a ref prefix so it cannot become "list everything", and the
service only ever asks for the configured prefix. Reviewing that row is R5's acceptance criterion
working, not an obstacle to it.

## Consequences

- **The REST surface is untouched.** `scripts/check/verify-gateway.ts` — Phase 2's stated exit
  condition — still passes unchanged. A failure there means the adapter disturbed something it
  should not have.
- **Refusals read as sentences.** Decap shows `json.error` to the person editing, so the proxy
  shapes its own error body with the human text in `error`. The REST routes keep the machine code
  there, because a scripted client wants a stable field. Two mappers, one set of policies.
- **The audit log names the action.** One endpoint carries every operation, so `AuditRecord` gained
  an optional `action`. Without it an operator would see a run of identical `POST /v1/cms/proxy`
  lines and could not tell a draft save from an attempt to publish (R9).
- **Listing a collection costs a blob read per page.** Decap's entry shape carries content, so
  showing a collection reads every file in it. Reads are chunked rather than fanned out at once,
  and at the current corpus size this is comfortable; a corpus an order of magnitude larger would
  want a cache.
- **Authors meet one extra click.** Decap's proxy backend renders its own login page, whose button
  resolves immediately — there is no second credential. An author returning from the identity
  provider still clicks it. Removing it means reaching into Decap's internals, which its own
  documentation warns is unstable.
- **Deleting a published page is not offered.** Decap would send it as a direct write, which branch
  policy refuses anyway. It is refused here with a reason instead, and remains an engineer's job
  until it is worth designing properly.
- **Media was absent by construction.** `PERMITTED_EXTENSIONS` is markdown only, so the media
  library listed nothing and uploads were refused with an explanation. R15 was a separate change,
  and it touched the write confinement R3 rests on — settled since by
  [ADR 0021](./0021-images-travel-with-the-draft.md), which adds a second confined folder rather
  than widening this one. Markdown pages are still the only thing `PERMITTED_EXTENSIONS` admits.
- **Decap's backend API is explicitly unstable.** Its own docs say there is no finalised, documented
  API. `decap-cms-app` is pinned exactly, and the zod schemas in `cms/decap/protocol.ts` are what
  turn an upstream shape change into a failing test rather than a silent misbehaviour.
