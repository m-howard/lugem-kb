---
title: 0007 — Single lockfile, no pnpm parity
sidebar_label: 0007 Single lockfile
owner: platform
last_reviewed: 2026-08-09
---

# ADR 0007 — Single lockfile, no pnpm parity

- **Date:** 2026-08-09
- **Status:** Accepted
- **Supersedes:** an earlier plan to commit `bun.lock` and `pnpm-lock.yaml` side by side

## Context

The repository was scaffolded to commit two lockfiles — `bun.lock` for day-to-day work and
`pnpm-lock.yaml` to prove the project also installs cleanly under Node's usual toolchain.
`.gitattributes` marked both `linguist-generated`, and this ADR's filename was reserved to justify
the arrangement.

The claim being bought is "this works under Node too." The price is paid on every dependency
change, forever:

- Two resolutions that can and do diverge, so a bug can reproduce under one and not the other.
- Two CI install paths, doubling install time on every run.
- Two files to update per Dependabot PR, each a merge-conflict surface.
- A standing question for contributors about which one is authoritative.

Two things changed the calculation. Pulumi gained a first-class `bun` runtime
([ADR 0004](./0004-pulumi-with-bun-runtime.md)), so Node is not load-bearing even for
infrastructure. And nothing in this repository is published to a registry — there is no downstream
consumer whose installer we need to reassure.

## Decision

One lockfile: `bun.lock`. Bun is the only package manager.

No `pnpm-lock.yaml`, no `package-lock.json`, no `yarn.lock`, no `pnpm-workspace.yaml`. CI installs
once, with Bun.

Node stays pinned in `.nvmrc` (24 LTS) because Docusaurus and some tooling still shell out to it.
That is a runtime dependency of the tooling, not a second installation path.

## Consequences

- One resolution, one install, one file to review.
- **Node-toolchain compatibility is no longer continuously proven.** If it ever matters — an
  outside contributor whose environment forbids Bun, or a decision to publish a package — the fix
  is a CI job that runs the built output under Node. That costs one workflow job, not a permanent
  second lockfile.
- Contributors must have Bun installed. `.bun-version` pins it and the README says so up front.
- **Revisit trigger:** publishing any workspace to npm, or a concrete report of someone unable to
  contribute because of the Bun requirement.
