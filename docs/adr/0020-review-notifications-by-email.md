---
title: 0020 — Review notifications by email, from GitHub Actions
sidebar_label: 0020 Review notifications
owner: platform
last_reviewed: 2026-08-10
---

# ADR 0020 — Review notifications by email, from GitHub Actions

- **Date:** 2026-08-10
- **Status:** Accepted
- **Resolves:** `requirements.md` open question Q7, "Chat platform for R14 notifications?"

## Context

R14 asks for two things: owners are notified when a pull request awaits their review, and authors
are notified when their submission is published or changes are requested. It is the only
engineering work Phase 4 contains — the other half of that phase is onboarding departments, and the
S3 sync it also names has been built since Phase 1.

R14 sat unbuilt behind Q7, which asked which chat platform to notify on. The question was owned by
the docs lead and answered **email**: no new platform dependency, no bot to register in a workspace
nobody has agreed on yet, and it reaches the authors R14 is mostly about — people who are not in
engineering channels and may not be in a chat workspace at all.

That answer settles the delivery mechanism. It leaves the harder question: what triggers a
notification, and with what credential.

## Decision

Deliver by email, from GitHub Actions, on a webhook.

1. **GitHub Actions, not a gateway webhook route.** Every trigger R14 names is a git host event, and
   this repository already has two event-driven jobs built exactly this way — `publish.yml` and
   `gap-report.yml`, both OIDC into a Pulumi-published role behind a `check-configuration` gate. A
   webhook route on the gateway would mean a new public inbound endpoint, a shared secret to
   rotate, and `ses:SendEmail` on the task role that serves readers. None of that buys anything the
   workflow does not already have.
2. **SES, with the sender pinned in the policy.** A third role, alongside publish and gap-report,
   for the same reason there is a second: a role that can publish the corpus should not also be
   able to send mail from a corporate-verified address. The policy grants `ses:SendEmail` on one
   identity with a `ses:FromAddress` condition, so the credential cannot send as anyone else in the
   account.
3. **Off unless a sender address is configured.** `notifySenderAddress` absent means no SES
   identity, no role, no Actions variables, and a workflow that skips cleanly — the same shape as
   the CMS half of the stack and `readerAuthRequired`. Notifying people is the one part of this
   system that reaches outside it, so it stays absent until an operator names the address it may
   send from.
4. **`pull_request_target`, and the rule that comes with it.** `pull_request` from a fork gets a
   read-only token and no OIDC, so it could never assume the role that sends mail.
   `pull_request_target` runs in the base repository's context, where the credential exists — and
   the workflow must therefore never check out, build or execute pull request code. It reads the
   event payload and the base branch's own `CODEOWNERS` and owner directory, nothing else.
5. **An explicit owner directory, `.github/docs-owner-emails.json`.** `CODEOWNERS` names GitHub
   handles and email needs addresses. Nothing in the GitHub API reliably bridges the two — user
   emails are private by default and usually return null. So the mapping is a reviewed file beside
   `CODEOWNERS`, and an owner with no entry is reported as unroutable rather than guessed at. Same
   stance the CODEOWNERS parser already takes: a near miss is worse than nothing.
6. **The author's address comes from the pull request body, and only from a CMS branch.** R6
   already puts the submitter's name and email there, written by the gateway from a verified token.
   Reading it back is gated on the head branch sitting under the CMS prefix, because that prefix is
   the one place only the gateway can write (R4).
7. **A recipient domain allowlist, defaulting to the sender's own domain.** The last guard on using
   a verified sender to mail strangers.
8. **Only the corpus routes a review request.** `CODEOWNERS` covers the whole repository, so
   resolving owners over every changed file would email a code owner on every engineering pull
   request. A notification people learn to ignore routes nothing.
9. **Plain text, one message per recipient.** Plain text renders everywhere and means a title, a
   name and a set of paths — none of which this system authored — can never become markup in
   somebody's inbox. One message per recipient means an owner does not learn who else owns a page
   from a header.

## Consequences

- **Q7 is closed, and closed narrowly.** Email is the delivery mechanism, not a statement that chat
  is unwanted. A chat surface later is a second sender behind the same recipient resolution, which
  is the part that was actually hard.
- **The owner directory is a file somebody has to maintain.** It ships empty, so until an operator
  fills it in no review request is routed and every run says so in the workflow log. That is the
  intended failure: visible and fixable, rather than mail to a guessed address.
- **The sender address needs verifying in SES, once.** `pulumi up` creates the identity and requests
  verification; an operator completes it. An unverified identity fails the first send loudly rather
  than silently delivering nothing.
- **SES starts in the sandbox.** A new account can only send to verified addresses until AWS grants
  production access. For a pilot with five authors that is survivable; for the rollout R14 exists to
  support it is a prerequisite, and it has a lead time.
- **`pull_request_target` is a footgun with a loaded warning label.** The workflow carries the rule
  as a comment because the failure mode — adding a `ref:` that points at the head — hands a fork
  write access to everything the job holds. It is the one file in this repository where a plausible
  edit is a privilege escalation.
- **Subject lines are sanitised, because a pull request title is untrusted input.** Carried into a
  header unaltered, a newline in a title ends the header and starts another. There is a test for it.
- **This closes Phase 4's only engineering requirement.** The rest of the phase is onboarding the
  remaining departments, and the S3 sync it also names has been built since Phase 1. Phase 3
  finished first after all — pull request previews (ADR 0018) and content quality gates (ADR 0019)
  landed while this was in review — so the phase order the plan assumes holds.
- **R14's criteria stay unticked in `requirements.md`, deliberately.** They are met only where an
  operator has set a sender and filled in the owner directory, which is the same reading R22 gets
  for the same reason: a checkbox that is false on a default deployment would be a lie in the one
  document meant to be checkable.

## Alternatives considered

- **A webhook route on the gateway.** Would put notification logic beside the editorial API that
  creates the pull requests, and could notify without a GitHub Actions round trip. Rejected: a new
  public inbound endpoint, a webhook secret to rotate, and mail-sending permission on the task role
  that serves every reader — three new pieces of attack surface for a job that runs a few times a
  day and has an established pattern in this repository already.
- **Slack or Teams.** Q7's original framing, and better for reviewers, who are engineers and are in
  those channels. Rejected by the docs lead: R14 is mostly about authors, who are not, and either
  choice adds a workspace dependency and an app registration to a project that has enough
  prerequisites already. Point 1 of the consequences is the escape hatch.
- **Derive owner emails from a domain convention** — `@org/docs-team` → `docs-team@org.com`.
  Removes the directory file. Rejected for the reason the CODEOWNERS parser refuses to guess at
  unsupported patterns: a near-miss address is mail to the wrong person, or to nobody, with no
  signal either way.
- **Look up emails through the GitHub API.** Removes the directory file, honestly. Rejected because
  it does not work: user emails are private by default and the API returns null for most accounts,
  so the fallback would be the directory file anyway.
- **`pull_request` instead of `pull_request_target`.** Safer by construction, and sufficient for the
  actual use case, since the CMS opens pull requests from same-repo `cms/*` branches. Rejected
  because it would silently notify nobody for a fork's pull request — a failure with no error, which
  is the kind this project tries hardest to avoid.
- **Notify on every changed file, not just the corpus.** Would make the feature useful to
  engineering review too. Rejected: it turns every code pull request into email, and the fastest way
  to make a notification worthless is to send too many.
