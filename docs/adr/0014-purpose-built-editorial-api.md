---
title: 0014 — A purpose-built editorial API, not a git host proxy
sidebar_label: 0014 Editorial API
owner: platform
last_reviewed: 2026-08-09
---

# ADR 0014 — A purpose-built editorial API, not a git host proxy

- **Date:** 2026-08-09
- **Status:** Accepted

## Context

[Requirements](../requirements.md) R5 says: _"Only the git host API calls the editorial workflow
requires are **proxied**."_ Its acceptance criteria are about an allowlist — the documented calls
succeed, repository administration is refused, an unmatched method and path combination is refused
with 403 and logged, and adding an entry requires a code change and review.

Read literally, that describes a transparent proxy: the CMS speaks the git host's REST API, the
gateway forwards what it recognises and refuses the rest. It has one large advantage — Decap CMS
speaks that API natively, so Phase 3 would be `api_root` configuration rather than an adapter.

It also has a shape problem. A proxy's surface is the union of everything any client might send, so
the policy has to reconstruct intent from payloads: is this `POST /git/trees` a draft save or an
attempt to rewrite `.github/`? The answer lives in a body the proxy did not compose. Attribution has
the same difficulty — R6 requires the commit author to come from the verified token, so the proxy
must parse, rewrite and re-serialise a payload it is otherwise passing through, which is no longer
proxying.

## Decision

Expose a purpose-built editorial API under `/v1/cms/*` — configuration, identity, documents, drafts
and submissions — and keep the allowlist as an **outbound** guard.

`git/endpoint-policy.ts` names every call the gateway may make at the git host.
`git/github-client.ts` is the only module that calls `fetch` against it, and checks that table
before the token is even read. Repository administration is refused by having no entry.

R5's criteria are still met, with the enforcement point moved:

| Criterion                                               | Where it now holds                                                                                                                      |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| The documented allowlist succeeds                       | `endpoint-policy.ts`, asserted row by row                                                                                               |
| Repository administration is refused                    | absent from the table; also absent from the App's permissions                                                                           |
| An unmatched method/path is refused with 403 and logged | outbound: `EndpointPolicyError` → 403 + audit record. Inbound: `/v1` is terminated with a JSON 404 so nothing falls through to the site |
| Adding an entry requires a code change and review       | the table is a source file, owned in `CODEOWNERS`                                                                                       |

Because the gateway composes every request, intent is known rather than inferred: `PUT
/v1/cms/drafts/{branch}` validates the branch and every path _before_ the first upstream call, and
the commit payload is built by `attribution.ts` from the verified identity, with no field a client
could use to name someone else.

## Consequences

- **Refusals are cheap and total.** A refused change set costs no upstream call and no credential
  use, which is what makes "a policy failure never partially applies" true rather than likely.
- **Attribution is structural.** `buildCommitPayload` takes the identity as an argument and the
  request type has no author field. There is nothing to discard because there is nowhere to supply.
- **The upstream surface is small enough to read.** Fifteen calls, each named in prose. A proxy's
  allowlist would have to admit everything Decap sends, including calls the workflow does not need.
- **Phase 3 costs more.** Decap cannot be pointed at this API with configuration; it needs an
  adapter — its `proxy` backend protocol is the closest fit. That is the real price of this
  decision, and it is paid by the phase that adds the CMS rather than by this one.
- **`GET /v1/cms/identity` is answered locally.** With one App credential, asking the git host who
  is calling returns the App. R6 needs the human, so the identity comes from the verified token and
  never leaves the gateway.
- **R5's wording is now slightly wrong.** The requirement says "proxied"; nothing is. The rule it
  was protecting — the CMS credential reaches only the calls the editorial workflow needs — holds.
  Update the requirement the next time it is revised rather than bending the design to the word.
