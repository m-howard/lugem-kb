---
title: 0008 — Coverage gate on logic only
sidebar_label: 0008 Coverage gate
owner: platform
last_reviewed: 2026-08-09
---

# ADR 0008 — Coverage gate on logic only

- **Date:** 2026-08-09
- **Status:** Accepted

## Context

A coverage percentage is only as meaningful as its denominator. Two failure modes are common, and
this repository is exposed to both.

**Too low a threshold does not bind.** The gateway's core is small pure functions — path policy,
config validation, retrieval thresholding. Tests written to cover them at all land near 90%
naturally, so a 60% gate never fails and never tells anyone anything.

**The wrong denominator inflates the number.** A Pulumi program is mostly declarative: `new
aws.s3.BucketV2(...)`, `new aws.ecs.Service(...)`. Import the module and every one of those lines
counts as covered, without a single assertion about the resulting infrastructure. Including
`infra/pulumi/src/*.ts` wholesale would let hundreds of untested lines carry the percentage.

## Decision

Threshold **80** on statements, lines, functions and branches.

Measured over:

- `apps/gateway/src/**/*.ts` — except `index.ts`, which is process bootstrap
- `infra/pulumi/src/config.ts` and `infra/pulumi/src/github-config.ts` — the stack's validation
  logic, and the only genuinely testable part of the program
- `scripts/docs/codeowners.ts` — the CODEOWNERS parser. Most of `scripts/` is I/O orchestration and
  stays out, but this one file decides who hears about a documentation gap, and its last-match-wins
  rule fails silently when it is wrong (added with [ADR 0015](0015-recording-documentation-gaps.md))

Everything else in `infra/pulumi/src` is excluded: it wires resources, and the honest test for
resource wiring is `pulumi preview`, which CI runs separately.

## Consequences

- The number reflects tested logic, so it can fail for a real reason.
- **Resource wiring is not covered by the gate**, and should not be mistaken for covered. Its
  guard is the `pulumi preview` job, plus the validation in `network.ts` that fails preview when
  subnets do not belong to the configured VPC.
- Adding logic to a Pulumi module means either extracting it into a tested pure function or
  adding that file to the coverage `include`. Extracting is preferred — the pattern already exists
  as `config.ts` (pure, tested) versus `read-config.ts` (engine-bound, thin, untested by design).
- Current coverage runs around 96% statements, so the gate has headroom. That is intended: it
  should catch a regression, not sit one test away from red.
