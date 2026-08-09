---
title: Deploying to AWS
sidebar_position: 4
owner: platform
last_reviewed: 2026-08-09
---

# Deploying to AWS

The Pulumi program deploys the gateway to ECS Fargate **inside a VPC you already have**, and
creates an S3 corpus bucket and a Bedrock knowledge base backed by S3 Vectors.

## Three account prerequisites

All of these fail late and confusingly if you skip them, so check them first.

### 1. Bedrock model access for embedding

The knowledge base embeds documents with `amazon.titan-embed-text-v2:0`. Model access is granted
per account, per region, and is off by default.

1. Open the Bedrock console in your target region.
2. Go to **Model access** and request access to **Titan Text Embeddings V2**.
3. Wait for the status to become **Access granted**.

Without this, the stack deploys and the ingestion job fails.

### 2. Bedrock model access for answering

`POST /v1/ask` writes answers with the model named by `answerModelId`. That is a **separate**
grant from the embedding model, in the same console and the same region.

Pick the model first, and verify the ID against the region you are deploying to rather than
copying one from a document:

```bash
aws bedrock list-foundation-models --region "$AWS_REGION" \
  --by-output-modality TEXT --query 'modelSummaries[].modelId'

aws bedrock list-inference-profiles --region "$AWS_REGION" \
  --query 'inferenceProfileSummaries[].inferenceProfileId'
```

Prefer a plain foundation model. If you use a cross-region inference profile — an ID starting
`us.`, `eu.` or `apac.` — also set `answerModelRegions` to every region the profile can route to,
or the task role will be granted the profile without the models behind it.

Without this grant the stack deploys, `/healthz` stays green, and every question returns an error
frame.

### 3. A region where S3 Vectors is available

S3 Vectors is in fewer regions than S3. The stack refuses to preview in a region it does not
recognise, naming `aws:region` in the error. The verified list lives in
`infra/pulumi/src/config.ts`; if AWS has added a region since, set `allowUnverifiedRegion` rather
than editing the constant in a fork.

## Configure the stack

```bash
cd infra/pulumi
pulumi stack init dev
cp Pulumi.dev.yaml.example Pulumi.dev.yaml   # then edit it
```

| Key                       | Required | Notes                                                                          |
| ------------------------- | -------- | ------------------------------------------------------------------------------ |
| `aws:region`              | yes      | Must support S3 Vectors and have model access granted.                         |
| `vpcId`                   | yes      | An existing VPC. Nothing here creates one.                                     |
| `privateSubnetIds`        | yes      | For the Fargate tasks. Must belong to `vpcId`.                                 |
| `publicSubnetIds`         | yes      | For the load balancer. Must belong to `vpcId`.                                 |
| `answerModelId`           | yes      | Bedrock model that writes answers. No default — it names a billed resource.    |
| `answerModelRegions`      | no       | Regions a cross-region inference profile may route to. Defaults to the region. |
| `albScheme`               | no       | `internal` (default) or `internet-facing`.                                     |
| `certificateArn`          | no       | With it the listener is HTTPS and HTTP redirects; without it, plain HTTP.      |
| `desiredCount`            | no       | Default `1`.                                                                   |
| `cpu` / `memory`          | no       | Default `512` / `1024`.                                                        |
| `logRetentionDays`        | no       | Default `30`.                                                                  |
| `corpusPrefix`            | no       | Default `docs/`. Must end in `/`.                                              |
| `embeddingModelId`        | no       | Default `amazon.titan-embed-text-v2:0`.                                        |
| `answerMaxTokens`         | no       | Default `700`. Ceiling on answer length.                                       |
| `askRateLimitPerMinute`   | no       | Default `20`. Questions per client per minute on `/v1/ask`.                    |
| `retrievalScoreThreshold` | no       | Default `0.4`. Below it, no documentation is deemed to cover the question.     |
| `allowUnverifiedRegion`   | no       | Escape hatch for a newly added S3 Vectors region.                              |
| `corpusRepository`        | no       | Master switch for the GitHub half. Unset, no GitHub resources are managed.     |
| `cmsGitHubAppId`          | no       | With `cmsGitHubAppInstallationId`, the CMS app the gateway authenticates as.   |
| `cmsAuthMode`             | no       | Required once the app ids are set. `bearer` or `alb` — see below.              |

The GitHub half has several more keys of its own; they live in
[the corpus repository guide](./corpus-repository.md) rather than here, because setting any of them
also means supplying an admin token this stack otherwise never needs. The keys that configure the
authoring gateway itself — how authors authenticate, and what the CMS may write — are in
[the authoring gateway guide](./authoring-gateway.md#configure-it).

`retrievalScoreThreshold` is the one worth understanding before you change it. It decides whether a
question is answerable at all: below it the API says nothing covers the question, and the answer
model is never called. Raising it makes the assistant decline more readily; lowering it makes it
answer from weaker matches, and pay to do so.

Setting `corpusRepository` additionally puts the repository backing the knowledge base under
Pulumi's control — its branch rules, its publish pipeline and the CMS app credential. Those keys,
and the GitHub token they need, are documented in
[the corpus repository guide](./corpus-repository.md). Leave the key unset and the stack manages no
GitHub resources at all.

Setting `cmsGitHubAppId` goes one step further and switches the authoring gateway on. `cmsAuthMode`
then becomes required, because the gateway will not guess how to identify an author, and
`cmsAuthMode: alb` additionally requires `certificateArn` — ALB authentication is an HTTPS listener
action, so the preview fails rather than deploying a load balancer that cannot authenticate
anyone.

### Networking your VPC must already provide

The tasks run in private subnets with **no public IP**, so they need a route to S3, Bedrock and ECR
— either a NAT gateway, or VPC endpoints for `s3`, `bedrock-runtime`, `bedrock-agent-runtime`,
`ecr.api`, `ecr.dkr` and `logs`. Without one of those, tasks start and then fail to pull the image.

The stack validates that every configured subnet actually belongs to `vpcId`, and fails during
`preview` if not. It does **not** check your routing — that part is on you.

## Deploy

```bash
bun run infra:preview   # read this before continuing
bun run infra:up
```

The image build happens as part of `up`: Pulumi builds `apps/gateway/Dockerfile` with the repo
root as context, because the Docusaurus content root is the repo-root `docs/` tree.

Outputs:

```bash
pulumi stack output siteUrl            # where the site and API are served
pulumi stack output corpusBucketName
pulumi stack output knowledgeBaseId
pulumi stack output dataSourceId
```

With `corpusRepository` set there are three more — `corpusRepositoryFullName`, `publishRoleArn` and
`cmsAppSecretArn`. They are omitted otherwise.

## Populate the knowledge base

The stack creates an empty corpus bucket and an empty index. Fill both:

```bash
export AWS_REGION=$(pulumi -C infra/pulumi config get aws:region)
export CORPUS_BUCKET=$(pulumi -C infra/pulumi stack output corpusBucketName)
export KNOWLEDGE_BASE_ID=$(pulumi -C infra/pulumi stack output knowledgeBaseId)
export DATA_SOURCE_ID=$(pulumi -C infra/pulumi stack output dataSourceId)

bun run corpus:sync --dry-run   # see what would change
bun run corpus:sync
```

The script uploads every markdown file, **deletes objects that no longer exist locally**, then
starts an ingestion job and waits for it to finish. Deletion is not optional: a page removed from
the repository must stop being answerable, or the knowledge base keeps citing a page the site no
longer has.

Run it by hand once, to prove the wiring. After that the `Publish` workflow runs the same script on
every merge that touches `docs/`, reading the same four values from repository variables Pulumi
publishes — see [the corpus repository guide](./corpus-repository.md).

## Verify

```bash
SITE=$(pulumi -C infra/pulumi stack output siteUrl)
curl -fsS "$SITE/healthz"
curl -fsS "$SITE/v1/documents" | head
curl -fsS -X POST "$SITE/v1/search" \
  -H 'content-type: application/json' \
  -d '{"question":"what is in this knowledge base?"}'

# The answering endpoint. -N disables curl's buffering so you see the stream arrive.
curl -fsS -N -X POST "$SITE/v1/ask" \
  -H 'content-type: application/json' \
  -d '{"question":"how do I deploy into an existing VPC?"}'
```

A covered question streams a `citations` frame first, then `token` frames, then `done`. Open
`$SITE` in a browser and use **Ask the docs** to check the same path through the UI.

A question the corpus does not cover returns `{"covered": false, ...}` rather than an invented
answer — as plain JSON, not a stream, because no model was called to produce it. That is the
intended behaviour, not a failure. Confirm it in CloudWatch: the log line reads
`"decision":"no-coverage"`, and no question text appears anywhere in the log group.

## What this costs

| Resource                             | Idle cost                      |
| ------------------------------------ | ------------------------------ |
| ECS Fargate, 0.5 vCPU / 1 GB, 1 task | ~$15/month                     |
| Application Load Balancer            | ~$18/month                     |
| S3 corpus bucket                     | cents                          |
| **S3 Vectors index**                 | **pay-per-use, no idle floor** |
| Bedrock embeddings                   | per token, at ingestion        |
| **Bedrock answer generation**        | **per token, per question**    |
| CloudWatch Logs                      | per GB ingested                |

Two lines are worth noting.

The vector store, because an OpenSearch Serverless collection — the conventional choice for a
Bedrock knowledge base — bills roughly **$700/month with no traffic at all**. S3 Vectors is why
this stack is affordable to leave running; see
[ADR 0005](./adr/0005-bedrock-knowledge-base-on-s3-vectors.md).

Answer generation, because it is the only line here that **scales with reader traffic**. Everything
else is a fixed idle cost. Input tokens dominate — each question carries the grounding rules, up to
five retrieved passages, and the conversation so far — which is why history is capped. Bedrock
pricing is per model and changes; check
[the Bedrock pricing page](https://aws.amazon.com/bedrock/pricing/) rather than a number written
down here.

Two things keep it bounded. A question nothing covers costs one retrieval and no generation, and
`askRateLimitPerMinute` caps how fast a single client can spend. Neither is a substitute for a
budget alarm on an internet-facing deployment — the endpoint is unauthenticated, and
[ADR 0012](./adr/0012-grounded-generation-behind-retrieval.md) records why.

## Tear down

```bash
bun run infra:destroy
```

The corpus bucket has `forceDestroy: false` and versioning on, so `destroy` will refuse while it
holds objects. That is intentional — the corpus is the product. Empty it deliberately:

```bash
aws s3 rm "s3://$CORPUS_BUCKET" --recursive
```

## Troubleshooting

**`preview` fails naming `aws:region`.** S3 Vectors is not available there, or the region string
is wrong. See prerequisite 3.

**`preview` fails naming `answerModelId`.** The key is unset. It is required and has no default —
see prerequisite 2.

**`preview` fails naming subnets.** One or more subnets belong to a different VPC than `vpcId`.

**The task exits at start-up saying `ANSWER_MODEL_ID`.** The gateway refuses to start without it,
by design. If `pulumi up` succeeded, the task definition is stale — redeploy.

**Tasks start then stop, with no application logs.** The task could not pull the image. Check the
private subnets have a route to ECR and CloudWatch Logs.

**The service is healthy but `/readyz` returns 503.** The task role cannot reach the corpus bucket.
The policy is scoped to one bucket and one prefix — confirm `corpusPrefix` matches where the sync
script actually uploaded.

**`/readyz` returns `cms-credential-unusable`.** With `cmsGitHubAppId` set, the stack creates the
App's secret but leaves it empty on purpose — the private key is written out of band. Until it is,
no installation token can be minted and the task correctly refuses to accept traffic. Liveness stays
green, so the task is not restarted into the same problem. See
[the corpus repository guide](./corpus-repository.md).

**The task exits with code 78 naming a `CMS_` or `AUTH_` variable.** Fail-closed configuration
working as intended: `CMS_REPOSITORY` makes the whole CMS block required, and every offender is
named at once. Check the stack keys against
[the authoring gateway guide](./authoring-gateway.md#configure-it), then `pulumi up`.

**Ingestion completes but `/v1/search` finds nothing.** Check the model access from prerequisite 1,
and confirm `embeddingModelId` matches the dimension the index was created with. Changing the
embedding model requires recreating the index.

**`/v1/search` works but `/v1/ask` sends an `error` frame.** Retrieval is fine and generation is
not. In order of likelihood:

1. **Model access was never granted** for `answerModelId` — prerequisite 2. This is the common one.
2. **`answerModelId` is a cross-region inference profile and `answerModelRegions` is unset.** The
   task role then holds the profile ARN without the foundation models behind it, and the
   AccessDenied names the profile, which sends you to the wrong console page. Set every region the
   profile can route to.
3. **The model ID does not exist in this region.** Check it with `aws bedrock
list-foundation-models`; the failure is a `ValidationException` naming the ID.

The CloudWatch log line reads `"decision":"answer-failed"` with the underlying message in `err`.

**Answers cut off partway through, always at the same length.** `answerMaxTokens` is too low for
the questions being asked. Raise it; the default of 700 is sized for roughly four sentences.

**Long answers are truncated intermittently, under load.** The ALB idle timeout is 120 seconds and
resets on every byte, so this points at a slow first token rather than a slow answer. Streaming the
citations frame first is what normally keeps the connection alive; check the model is not being
throttled.
