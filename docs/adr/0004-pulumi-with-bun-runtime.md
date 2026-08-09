---
title: 0004 — Pulumi with the bun runtime
sidebar_label: 0004 Pulumi on bun
owner: platform
last_reviewed: 2026-08-09
---

# ADR 0004 — Pulumi with the bun runtime

- **Date:** 2026-08-09
- **Status:** Accepted

## Context

Pulumi's TypeScript support has historically meant `runtime: nodejs` plus `ts-node`, which brings
its own `tsconfig` resolution, its own module-resolution quirks, and a startup cost on every
`preview`. The alternative was compiling to JavaScript first and pointing `main` at the output —
correct, but it puts a build step between editing a stack and previewing it.

Pulumi added a first-class `bun` runtime in CLI **3.226.0**. Bun executes the TypeScript directly.

## Decision

`infra/pulumi/Pulumi.yaml` declares:

```yaml
runtime: bun
main: index.ts
```

Minimum Pulumi CLI version is 3.226.0, documented in
[Getting started](../getting-started.md#prerequisites).

## Consequences

- No `ts-node`, no compile step, no `tsconfig` plumbing between the program and the engine.
- The infra program runs on the same runtime as the service, so there is one TypeScript
  configuration story rather than two.
- **Floor on the Pulumi CLI version.** A contributor on 3.225 or earlier gets an unrecognised
  runtime rather than a graceful fallback.
- When `runtime: bun` is set, Pulumi ignores the `typescript`, `tsconfig`, `nodeargs` and
  `packagemanager` options — Bun resolves all of that itself. Setting them is not an error, just
  silently inert, which is worth knowing before debugging why one had no effect.
- `tsc` still runs over the program in CI for type checking. Its emit goes to
  `node_modules/.tsbuild` and nothing consumes it.
