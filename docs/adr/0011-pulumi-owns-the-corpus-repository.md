---
title: 0011 — Pulumi owns the corpus repository
sidebar_label: 0011 Corpus repository in Pulumi
owner: platform
last_reviewed: 2026-08-09
---

# ADR 0011 — Pulumi owns the corpus repository

- **Date:** 2026-08-09
- **Status:** Accepted

## Context

The knowledge base is backed by a git repository. Merging to its default branch is what publishes a
page, and [`requirements.md`](../requirements.md) is specific about what that repository must look
like: code-owner review on the default branch with direct pushes blocked for every principal
including the CMS app (R8), a pipeline that syncs markdown to S3 and triggers ingestion on merge
(R11), an index that only ever sees default-branch content (R21), and a gateway holding one GitHub
App credential read from a secret store (R2).

All of it was configured by hand, in the settings UI, where a bypass entry added once during an
incident is invisible forever afterwards.

The wiring was worse than the governance. `scripts/docs/sync-corpus.ts` requires `CORPUS_BUCKET`,
`KNOWLEDGE_BASE_ID` and `DATA_SOURCE_ID`. All three are stack outputs. The documented procedure was
to read them out of `pulumi stack output` and paste them into GitHub — a step that is correct
exactly until the first time a stack is rebuilt, after which the pipeline writes confidently to a
bucket that no longer exists. Meanwhile the script's own header said it "runs from CI after a
merge", and no workflow invoked it at all.

## Decision

The repository backing the knowledge base is configured by this stack, through three components:
`CorpusRepository` (settings, ruleset, labels, Actions hardening), `PublishPipeline` (the GitHub
OIDC provider, the publish role, the deployment environment, and six Actions variables) and
`CmsCredential` (the Secrets Manager secret and the App installation).

They live in the same Pulumi project as the AWS resources, not a separate one. A second project
would isolate repository configuration from application infrastructure, which is a real benefit —
but the four values that make this worth doing are `Output`s of the AWS half, and pushing them
across a `StackReference` boundary trades a genuine problem for a bootstrapping order that has to be
kept straight by hand.

`lugem-kb:corpusRepository` is the master switch. Unset, the stack manages no GitHub resources at
all and behaves exactly as it did before this ADR.

The `github.Repository` resource itself is only managed when the stack is told to create a
repository or to adopt one via `corpusRepositoryImportId`. Pointing `corpusRepository` at an
existing repository without either flag configures the rules and leaves the repository's own
settings alone.

## Consequences

- `pulumi preview` now needs a GitHub token once `corpusRepository` is set — the provider has to read
  the repository's current rules to diff them. CI supplies it as `GH_ADMIN_TOKEN`, mapped to
  `GITHUB_TOKEN`, because GitHub forbids secrets named `GITHUB_*`.
- A publish pipeline that was three manual copy-paste steps is now a consequence of `pulumi up`.
  Rebuilding a stack repoints the workflow at the new bucket and data source automatically.
- `archiveOnDestroy: true` on the repository. `pulumi destroy` must not be able to delete the
  corpus — the same instinct as `forceDestroy: false` on the bucket holding its published copy.
- The ruleset carries `bypassActors: []`, so an administrator who needs to push directly has to
  change infrastructure code and get it reviewed. That is the point, and it will be inconvenient at
  least once.
- Only R8 is enforced by GitHub. R4 branch confinement and R5 endpoint allowlisting stay the
  gateway's job — GitHub cannot express "this app may only create refs under `cms/`", and a ruleset
  that pretended to would be worse than none.
- `CmsCredential` creates the secret **empty**. Until the PEM is written out of band the gateway's
  readiness probe fails, which is [ADR 0009](0009-fail-closed-configuration.md) working rather than
  an outage: a miscredentialed task never joins the target group.
- Pulumi cannot create a GitHub App, and cannot mint a Pulumi Cloud token. Those two remain manual
  bootstrap steps, documented in [the corpus repository guide](../corpus-repository.md).
