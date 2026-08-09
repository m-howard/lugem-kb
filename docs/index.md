---
slug: /
title: Lugem Knowledge Base
sidebar_position: 1
owner: platform
last_reviewed: 2026-08-09
---

# Lugem Knowledge Base

Documentation that publishes itself and answers questions.

Lugem KB keeps a documentation corpus in git, publishes it as a static site, and indexes the same
markdown into an Amazon Bedrock knowledge base so readers can ask questions and get answers with
citations back to the source page.

This repository is the reference implementation: a Bun monorepo, a Docusaurus site, a Hono service
on ECS Fargate, and a Pulumi program that deploys the lot into an **existing** VPC.

## What is here

| Area           | Path                          | What it does                                                     |
| -------------- | ----------------------------- | ---------------------------------------------------------------- |
| Site           | `apps/docs`                   | Docusaurus build. Its content root is this `docs/` tree.         |
| Service        | `apps/gateway`                | Serves the built site plus a read-only API over the corpus.      |
| Infrastructure | `infra/pulumi`                | ECR, ECS Fargate, ALB, S3 corpus bucket, Bedrock knowledge base. |
| Corpus sync    | `scripts/docs/sync-corpus.ts` | Uploads markdown to S3 and triggers ingestion.                   |

## One corpus, two consumers

The markdown in `docs/` is the single source. The site publishes it and the knowledge base ingests
it, from the same commit. Nothing is duplicated, so the site and the answers cannot drift apart —
if a page is wrong, both are wrong together, which is the only kind of inconsistency you can
actually fix.

## Where to go next

- **[Getting started](./getting-started.md)** — run the site and the service locally.
- **[Deploying to AWS](./deploying-to-aws.md)** — prerequisites, stack config, and teardown.
- **[Architecture decision records](./adr/)** — why each piece is the way it is.
- **[Requirements](./requirements.md)** — the product this scaffold is the first phase of.

## Status

This is the Phase 1 scaffold described in [requirements](./requirements.md) §9: corpus in git, site
building, deployment stood up — plus a working retrieval slice of Phase 5. The authoring gateway
(Decap CMS and the GitHub App credential broker) is not built yet.
