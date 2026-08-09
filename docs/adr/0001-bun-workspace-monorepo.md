---
title: 0001 — Bun workspace monorepo
sidebar_label: 0001 Bun workspace monorepo
owner: platform
last_reviewed: 2026-08-09
---

# ADR 0001 — Bun workspace monorepo

- **Date:** 2026-08-09
- **Status:** Accepted

## Context

Three deliverables ship together and share nothing but types: a Docusaurus site, a Bun HTTP
service, and a Pulumi program. They also share a lifecycle — the container image contains the
built site, and the Pulumi program builds that image — so a change can span all three.

Split repositories would mean version-coordinating a site build into an image build into a
deployment, for a project with one team and one release cadence.

## Decision

One repository, Bun workspaces, three packages:

```text
apps/docs      @lugem/docs    Docusaurus site
apps/gateway   @lugem/gateway Bun + Hono service
infra/pulumi   @lugem/infra   Pulumi program
```

No task orchestrator. Bun's `--filter` covers cross-workspace scripts, and three packages do not
justify Turborepo's cache configuration or Nx's project graph.

The corpus itself lives at the repo root in `docs/`, outside any workspace, because two things
consume it — the site publishes it and the sync script uploads it — and neither owns it.

## Consequences

- One `bun install`, one lockfile, one CI install step.
- A change spanning site, service and infra is one commit and one review.
- The Docker build context is the repo root, not `apps/gateway`. `.dockerignore` must **not**
  exclude `docs/`, and there is a comment there saying so.
- If a fourth or fifth package appears and full builds get slow, revisit the no-orchestrator
  decision. Three is comfortably under that threshold.
