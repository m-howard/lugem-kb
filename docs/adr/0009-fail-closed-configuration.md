---
title: 0009 — Fail-closed configuration
sidebar_label: 0009 Fail-closed config
owner: platform
last_reviewed: 2026-08-09
---

# ADR 0009 — Fail-closed configuration

- **Date:** 2026-08-09
- **Status:** Accepted

## Context

[Requirements](../requirements.md) R10 asks for fail-closed configuration: a missing required
variable must prevent start-up with a named error, and readiness must fail until the service can
actually do its job.

The tempting alternative is a default. `CORPUS_PREFIX` defaulting to `docs/` looks harmless. But
defaults turn a configuration mistake into a runtime one: the service boots, passes its health
check, joins the target group, and serves 500s or — worse — reads from a prefix nobody intended.
The failure surfaces far from its cause, in a log line an operator has to correlate against a
schema they cannot see.

The same argument applies to the Pulumi stack, where the analogous failure is a half-built stack:
`up` creates a bucket, IAM roles and a service, then fails on the vector bucket because the region
does not support S3 Vectors.

## Decision

Three rules, applied in both the service and the stack.

**1. Required means required.** No defaults for anything that identifies a resource:
`AWS_REGION`, `CORPUS_BUCKET`, `CORPUS_PREFIX`, `KNOWLEDGE_BASE_ID`, `SITE_ROOT` in the service;
`vpcId`, `privateSubnetIds`, `publicSubnetIds` in the stack. Defaults are only for tuning —
`PORT`, `LOG_LEVEL`, `desiredCount`, `cpu`.

**2. Errors name the variable.** `ConfigError` and `StackConfigError` both carry the offending
keys and put them in the message, so the first line of a crash loop says what to fix. Every
offender is reported at once, not just the first.

**3. Validate as early as the information exists.** The service exits with `EX_CONFIG` (78) before
opening a socket. The stack validates in `validateStackConfig` — pure, I/O-free — so `preview`
fails before the first AWS call.

## Consequences

- A misconfigured task never becomes healthy, so it never joins the target group.
- A misconfigured stack fails at preview, not halfway through `up`.
- **Local development needs a complete `.env`.** `.env.example` lists every variable with a
  comment saying what it is for, and the [getting started](../getting-started.md) guide names the
  fail-closed exit as expected behaviour rather than a bug.
- Because validation is pure, the whole rule set is unit-tested without a process, a network or a
  Pulumi engine — see `apps/gateway/src/config.test.ts` and `infra/pulumi/src/config.test.ts`.

## Related

`/healthz` and `/readyz` are split for the same reason and are not the same decision: liveness
must not depend on S3, or an upstream outage cycles every task and turns a dependency blip into an
outage of our own making. Readiness must depend on S3, because a task that cannot read the corpus
has nothing to serve.
