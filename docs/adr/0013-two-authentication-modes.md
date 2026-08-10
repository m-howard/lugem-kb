---
title: 0013 — Two authentication modes behind one interface
sidebar_label: 0013 Two auth modes
owner: platform
last_reviewed: 2026-08-09
---

# ADR 0013 — Two authentication modes behind one interface

- **Date:** 2026-08-09
- **Status:** Accepted
- **Amended by:** [ADR 0016](0016-reader-authentication.md)

## Context

[Requirements](../requirements.md) R1 asks authors to authenticate without a git host account, and
says a request the gateway cannot attribute is refused with 401. Two of the requirements' own open
questions block the obvious implementation:

- **Q3** — which identity provider fronts this: Cognito federating to Entra, or Entra directly?
- **Q4** — does the access token carry email and name claims, or must they come from the ALB header?

Q4 is the one that is easy to underestimate. Several providers omit `email` from the access token by
default, and the gateway refuses a request it cannot attribute — so the answer decides whether
authors can publish at all.

There are two credible shapes, and they differ in where the OIDC exchange happens:

**A bearer token the editor holds.** The CMS obtains an access token and sends it as
`Authorization: Bearer`. The gateway verifies it against the issuer's key set. Nothing else in the
deployment has to change, it works on a laptop, and a scripted client can hold a token — which is
what the Phase 2 exit criterion asks for.

**A JWT the load balancer signs.** The ALB runs `authenticate-oidc`, completes the exchange with the
provider, and forwards a signed `x-amzn-oidc-data` header. The gateway verifies the ALB's signature.
Nothing in the browser handles a token, and the ALB refuses unauthenticated requests before they
reach a task. It needs an HTTPS listener, a certificate, and a registered application — none of
which this stack has today.

Picking one now means picking before Q3 is answered.

## Decision

Build both, behind one `IdentityVerifier` interface, selected by `AUTH_MODE`.

`apps/gateway/src/auth/verifier.ts` defines the interface; `bearer-verifier.ts` and
`alb-verifier.ts` implement it; `createVerifier` in `cms/dependencies.ts` is the only place that
chooses. Every route, policy and audit record is written against the interface and never learns
which is deployed.

Three details are load-bearing rather than incidental:

1. **Claim names are configuration.** `AUTH_EMAIL_CLAIM` and `AUTH_NAME_CLAIM` default to `email`
   and `name`. Q4 becomes a config change rather than a code change.
2. **ALB mode checks the signer.** The header alone is not a credential — anything that can reach
   the task can set one. What makes it a credential is the signature _plus_ `signer` matching this
   stack's load balancer ARN. Checking the signer before fetching a key also means a forged token
   costs no network call, and keeps the key cache bounded.
3. **The algorithm is pinned.** ALB tokens are verified as ES256 because that is what an ALB signs
   with, not because the token says so. Letting a credential nominate the algorithm it is checked
   with is how `alg: none` works.

In ALB mode the `authenticate-oidc` action is a listener **rule** scoped to `/v1/cms/*`, never the
listener's default action.

## Consequences

- **Q3 and Q4 stop blocking the build.** Whichever way they land, the answer is configuration.
- **Twice the authentication surface**, and it is genuinely twice: two verifiers, two failure
  vocabularies to keep aligned, two paths through the configuration validator.
- **Only one mode is provable end to end today.** Bearer mode is exercised by the integration suite
  and by `scripts/check/verify-gateway.ts` against a real deployment. ALB mode is unit-tested
  against a generated EC key and a faked key endpoint; its listener rule is preview-only until
  someone runs it against a real ALB with a certificate and a registered application. That gap is
  real, and stating it is better than implying parity.
- **Authenticating at the edge does not remove the check in the service.** In ALB mode the rule
  decides who may reach `/v1/cms`; the verifier decides who the request is _from_. Removing the
  second would trust any load balancer in the region.
- `/v1/ask` stays unauthenticated. R22 belongs to Phase 5, and turning it on now would put a login
  in front of every reader for a benefit nobody has asked for yet.

  _Amended by [ADR 0016](0016-reader-authentication.md)._ Phase 5 built R22 on top of the interface
  this ADR introduced, which is the clearest evidence the interface was the right call: reader
  authentication became a configuration change rather than a rewrite. It still defaults to off, for
  exactly the reason stated above.
