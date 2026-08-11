---
title: 0017 — Reader authentication, built and switched off
sidebar_label: 0017 Reader authentication
owner: platform
last_reviewed: 2026-08-10
---

# ADR 0017 — Reader authentication, built and switched off

- **Date:** 2026-08-10
- **Status:** Accepted
- **Amends:** ADR 0013's "`/v1/ask` stays unauthenticated. R22 belongs to Phase 5"

## Context

R22 asks the chat endpoint to authenticate against the same identity provider as `/publisher`, and to
refuse anonymous access. ADR 0013 built two verification modes behind one interface but wired them
only to the editorial surface, recording the reason plainly: turning authentication on for readers
"would put a login in front of every reader for a benefit nobody has asked for yet".

Phase 5 is where R22 was deferred to. But the reason ADR 0013 gave has not expired — nobody has
since asked for a login in front of the documentation assistant. What has changed is that the
project now stores something about readers (ADR 0016), which makes "who is asking" a question worth
being able to answer, and that the rate limiter's blindness to identity has a cost worth fixing.

There is also a scope point worth stating, because it is easy to get wrong. R18 notes that every
reader can already read every page of the site. Chat therefore discloses nothing a reader could not
obtain by browsing. **R22 is about query-log sensitivity and cost, not about content
authorisation.** That is precisely why it can ship switched off: leaving it off does not leave a
door open onto anything.

## Decision

Build it end to end, default it off, and prove both states.

1. **`READER_AUTH_REQUIRED` defaults to `false`.** With it false, `/v1/ask`, `/v1/search` and
   `/v1/feedback` behave exactly as they did before this change, and `pulumi preview` shows no
   listener rule diff. An integration suite asserts that, because "we built it but it changes
   nothing" is a claim worth testing rather than asserting.
2. **One mechanism, not a second one.** Reader authentication reuses ADR 0013's `IdentityVerifier`,
   its two modes, and its claim configuration. The decision that paid off there is that the
   interface made this a configuration change rather than a rewrite.
3. **Auth configuration is lifted out of the CMS block.** It was reachable only through
   `CmsConfig`, so a deployment without a CMS had no verifier at all. The environment variable
   names are unchanged, so the refactor costs no operator anything.
4. **One verifier, built once and shared.** Two verifiers in one service could disagree about who
   is calling.
5. **Fail closed.** `READER_AUTH_REQUIRED=true` with no `AUTH_MODE` stops start-up naming
   `AUTH_MODE`. A service that boots believing it authenticates readers and does not is exactly the
   failure ADR 0009 exists to prevent.
6. **`GET /v1/identity` is new, and load-bearing.** An ALB session cookie is only ever issued by a
   listener rule whose action _authenticates_, and `/v1/cms/identity` — the existing one — is
   mounted only when the CMS is configured. Without exactly one reader path that redirects, a
   browser arriving with no cookie is told 401 forever and given no way to fix it.
7. **The reader rules use `allow`, not `deny`**, for the reason ADR 0013 already documents: an
   _expired_ session under `deny` is redirected to the identity provider, and the widget's `fetch`
   would try to parse an HTML login page as JSON. Under `allow` the gateway answers a JSON 401 with
   a reason, and the widget renders a sign-in link.
8. **The rate limiter keys on the subject when there is one**, and on the client address otherwise.
   The two key spaces are prefixed so they cannot collide.
9. **The site itself is never authenticated.** Only `/v1/ask`, `/v1/search`, `/v1/feedback` and
   `/v1/identity` — never the documentation, which every reader can already read.

## Consequences

- **R22's first checklist item is met only when the switch is on.** `requirements.md` records it
  that way rather than ticked, because "anonymous access is refused" is false by default and
  ticking it would be a lie in the one document that is supposed to be checkable.
- **The browser widget works in `alb` mode only.** Bearer mode expects a client that holds a token,
  which ADR 0013 framed as the scripted-client case; the widget never attaches an `Authorization`
  header, and a static Docusaurus build has no server-side session to mint one from. A deployment
  wanting authenticated readers through the widget needs ALB mode, and therefore a certificate.
- **No certificate becomes newly mandatory.** `authenticate-oidc` is an HTTPS listener action, so
  reader auth in `alb` mode inherits the prerequisite `cmsAuthMode: alb` already has, and is
  refused at preview without one. Deployments that do not switch it on are unaffected.
- **Reader auth currently borrows the editorial identity provider.** Requiring it on a stack with
  no CMS configured is refused at preview. Decoupling them means promoting the auth settings out of
  `CmsGatewayConfig` into their own block — correct, and not worth a large diff for behaviour that
  ships switched off. This is the known limitation of the shortcut.
- **The rate limiter is still not access control.** Re-keying on subject makes it fairer, not
  global: the window is still in memory per task, so with `desiredCount: n` the ceiling is
  `n × limit`. ADR 0012's note stands.
- **Turning it on has a real cost.** Every reader meets an identity provider round trip before
  their first question. That is the trade the switch exists to let somebody make deliberately,
  rather than inherit.

## Alternatives considered

- **Ship R22 on by default.** Satisfies Phase 5's exit criteria without an asterisk. Rejected for
  ADR 0013's original reason, which no one has since contradicted: it puts a login in front of every
  reader for a benefit nobody has asked for, and forces a certificate onto every deployment.
- **Leave R22 unbuilt and carry it as a follow-up.** Honest, and it leaves the requirement with no
  implementation to review or turn on — so the decision about whether to authenticate readers stays
  coupled to an engineering estimate. Building it decouples the two.
- **A second, reader-specific identity mechanism.** Would let readers authenticate against a
  different provider than editors. Rejected as a solution to a problem nobody has; it doubles the
  auth surface and ADR 0013's interface already covers both modes.
- **A runtime off-switch of the kind ADR 0012 rejected.** Worth distinguishing: 0012 rejected a flag
  that produced two answer behaviours and two UIs to keep working. This is a deployment posture with
  one client code path — the 401 branch exists whether or not anything ever returns 401 — so it does
  not carry the cost that argument was about.
