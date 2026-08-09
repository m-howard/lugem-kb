# Security policy

## Reporting a vulnerability

Please report security issues privately, not through the public issue tracker.

Use GitHub's [private vulnerability reporting](https://github.com/m-howard/lugem-kb/security/advisories/new)
for this repository. If that is unavailable to you, open an issue asking for a private channel —
without details — and a maintainer will follow up.

Please include what you can: affected version or commit, the component (`apps/gateway`,
`infra/pulumi`, `scripts/`), reproduction steps, and what an attacker gains.

Expect an acknowledgement within three working days and an assessment within ten. We will tell you
what we intend to do and when, and credit you in the advisory unless you would rather we did not.

## Supported versions

This project is pre-1.0. Only `main` receives fixes.

## Scope

In scope — anything reachable in this repository's code:

- Path handling in `apps/gateway/src/kb/key-policy.ts` and `apps/gateway/src/routes/site.ts`.
  Both resolve untrusted input to a location; a bypass of either is a real finding.
- Anything that widens the IAM policies in `infra/pulumi/src/iam.ts` or
  `infra/pulumi/src/knowledge-base.ts` beyond one bucket, one prefix, one knowledge base.
- Secret or credential leakage through logs — the redaction list is in
  `apps/gateway/src/logging.ts`.
- Anything that lets the gateway read outside its configured corpus prefix.

Out of scope:

- Misconfiguration of a deployment you control — an over-permissive VPC, a public ALB you meant to
  be internal, or credentials you supplied. The stack ships least-privilege defaults; changing them
  is your decision to make and to secure.
- Findings that depend on already having AWS credentials for the account.
- Dependency advisories with no demonstrated path through this code. Dependabot already tracks
  those; please open a normal pull request instead.

## What this project does not defend against

Stated plainly so nobody reports it as a finding:

- **Every reader can read every page.** There is no per-page read authorisation, by design
  ([requirements](docs/requirements.md) R18). Retrieval therefore discloses nothing the site does
  not already. If per-area restriction is ever added, the index must gain the same model on the
  same day, or retrieval becomes the bypass.
- **The gateway has no write path.** It holds no git host credential and cannot modify the corpus.
  The authoring gateway described in the requirements is not built yet.
