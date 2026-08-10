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

| Area           | Path                              | What it does                                                      |
| -------------- | --------------------------------- | ----------------------------------------------------------------- |
| Site           | `apps/docs`                       | Docusaurus build. Its content root is this `docs/` tree.          |
| Service        | `apps/gateway`                    | Serves the built site, the corpus API, and the authoring gateway. |
| Infrastructure | `infra/pulumi`                    | ECR, ECS Fargate, ALB, S3 corpus bucket, Bedrock knowledge base.  |
| Corpus sync    | `scripts/docs/sync-corpus.ts`     | Uploads markdown to S3 and triggers ingestion.                    |
| Publish        | `.github/workflows/publish.yml`   | Runs that sync on every merge, using variables Pulumi sets.       |
| Verification   | `scripts/check/verify-gateway.ts` | Drives a deployment through the gateway's acceptance list.        |

## One corpus, two consumers

The markdown in `docs/` is the single source. The site publishes it and the knowledge base ingests
it, from the same commit. Nothing is duplicated, so the site and the answers cannot drift apart —
if a page is wrong, both are wrong together, which is the only kind of inconsistency you can
actually fix.

## Where to go next

- **[Asking questions](./asking-questions.md)** — ask the corpus a question and read the answer.
- **[The authoring gateway](./authoring-gateway.md)** — publish a change without a git host account.
- **[Getting started](./getting-started.md)** — run the site and the service locally.
- **[Deploying to AWS](./deploying-to-aws.md)** — prerequisites, stack config, and teardown.
- **[The corpus repository](./corpus-repository.md)** — the branch rules and publish pipeline Pulumi
  configures on the repository backing the knowledge base.
- **[Architecture decision records](./adr/)** — why each piece is the way it is.
- **[Requirements](./requirements.md)** — the product this scaffold is the first phase of.

## Status

Phases 1 and 2 of [requirements](./requirements.md) §9 are built, the CMS half of Phase 3, and the
answering slice of Phase 5.

Phase 1 put the corpus in git, stood the site up and deployed it. Phase 2 added the authoring
gateway: authors authenticate against an identity provider, the gateway holds one GitHub App
credential they never see, and every write is confined to the documentation tree and the `cms/*`
branches before that credential is used. Phase 5's answering slice generates a short answer from the
retrieved passages rather than returning the passages alone.

Phase 3 added the CMS itself: Decap at [`/admin`](./editing-in-the-cms.md), reaching the editorial
API through an adapter in the gateway, so an author writes and submits a page without a git host
account or any knowledge of markdown. Pull request previews and content quality gates — the rest of
Phase 3 — are not built yet.
