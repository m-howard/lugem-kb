---
title: 0003 — Serve the site from ECS
sidebar_label: 0003 Site served from ECS
owner: platform
last_reviewed: 2026-08-09
---

# ADR 0003 — Serve the site from ECS

- **Date:** 2026-08-09
- **Status:** Accepted

## Context

The Docusaurus build is a static tree. The conventional home for one is S3 behind CloudFront:
cheaper per byte, cached at edge, and independent of any compute.

But the gateway already exists — it has to, for the retrieval API — and it already runs behind an
ALB in the target VPC. Serving the site from a second origin means a second deploy target, a
second cache invalidation story, and two places a reader's request can go wrong.

## Decision

The gateway serves the built site. One container, one origin, one deploy.

The Dockerfile builds Docusaurus in an earlier stage and copies `build/` into the runtime image.
`apps/gateway/src/routes/site.ts` serves it from disk, mounted **last** so `/healthz` and `/v1/*`
match first.

The static handler is implemented over `node:fs` rather than `hono/bun`'s `serveStatic`, which
touches the `Bun` global at import time and makes the whole app unimportable under the test runner.
Nothing about serving files needs a Bun-specific API.

## Consequences

- **Docs releases are service releases.** Fixing a typo means building and deploying a container.
  This is the real cost of the decision.
- No CDN. Every reader hits the ALB and a Fargate task. Fine at internal scale; not fine at public
  scale.
- Compute is paid for serving static bytes.
- **Route order is load-bearing.** A catch-all mounted before the API answers every API path with
  HTML and a 200 status, so health checks stay green and only a client parsing JSON notices.
  `apps/gateway/tests/integration/route-precedence.test.ts` and the e2e suite both guard it.
- Path containment is now this project's problem: serving files by request path is a traversal
  sink, so `site.ts` resolves to an absolute path and checks containment there rather than
  string-matching the request.

## Alternative, if this becomes painful

Put CloudFront in front with the ALB as origin, or move the site to S3 and route `/v1/*` to the
ALB. `site.ts` stays a thin mount specifically so that is a configuration change.
