---
title: Deploying to AWS
sidebar_position: 3
owner: platform
last_reviewed: 2026-08-09
---

# Deploying to AWS

The Pulumi program deploys the gateway to ECS Fargate **inside a VPC you already have**, and
creates an S3 corpus bucket and a Bedrock knowledge base backed by S3 Vectors.

## Two account prerequisites

Both of these fail late and confusingly if you skip them, so check them first.

### 1. Bedrock model access

The knowledge base embeds documents with `amazon.titan-embed-text-v2:0`. Model access is granted
per account, per region, and is off by default.

1. Open the Bedrock console in your target region.
2. Go to **Model access** and request access to **Titan Text Embeddings V2**.
3. Wait for the status to become **Access granted**.

Without this, the stack deploys and the ingestion job fails.

### 2. A region where S3 Vectors is available

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

| Key                     | Required | Notes                                                                     |
| ----------------------- | -------- | ------------------------------------------------------------------------- |
| `aws:region`            | yes      | Must support S3 Vectors and have model access granted.                    |
| `vpcId`                 | yes      | An existing VPC. Nothing here creates one.                                |
| `privateSubnetIds`      | yes      | For the Fargate tasks. Must belong to `vpcId`.                            |
| `publicSubnetIds`       | yes      | For the load balancer. Must belong to `vpcId`.                            |
| `albScheme`             | no       | `internal` (default) or `internet-facing`.                                |
| `certificateArn`        | no       | With it the listener is HTTPS and HTTP redirects; without it, plain HTTP. |
| `desiredCount`          | no       | Default `1`.                                                              |
| `cpu` / `memory`        | no       | Default `512` / `1024`.                                                   |
| `logRetentionDays`      | no       | Default `30`.                                                             |
| `corpusPrefix`          | no       | Default `docs/`. Must end in `/`.                                         |
| `embeddingModelId`      | no       | Default `amazon.titan-embed-text-v2:0`.                                   |
| `allowUnverifiedRegion` | no       | Escape hatch for a newly added S3 Vectors region.                         |

Setting `corpusRepository` additionally puts the repository backing the knowledge base under
Pulumi's control — its branch rules, its publish pipeline and the CMS app credential. Those keys,
and the GitHub token they need, are documented in
[the corpus repository guide](./corpus-repository.md). Leave the key unset and the stack manages no
GitHub resources at all.

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
```

A question the corpus does not cover returns `{"covered": false, ...}` rather than an invented
answer. That is the intended behaviour, not a failure.

## What this costs

| Resource                             | Idle cost                      |
| ------------------------------------ | ------------------------------ |
| ECS Fargate, 0.5 vCPU / 1 GB, 1 task | ~$15/month                     |
| Application Load Balancer            | ~$18/month                     |
| S3 corpus bucket                     | cents                          |
| **S3 Vectors index**                 | **pay-per-use, no idle floor** |
| Bedrock embeddings                   | per token, at ingestion        |
| CloudWatch Logs                      | per GB ingested                |

The vector store is the line worth noting. An OpenSearch Serverless collection — the conventional
choice for a Bedrock knowledge base — bills roughly **$700/month with no traffic at all**. S3
Vectors is why this stack is affordable to leave running; see
[ADR 0005](./adr/0005-bedrock-knowledge-base-on-s3-vectors.md).

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
is wrong. See prerequisite 2.

**`preview` fails naming subnets.** One or more subnets belong to a different VPC than `vpcId`.

**Tasks start then stop, with no application logs.** The task could not pull the image. Check the
private subnets have a route to ECR and CloudWatch Logs.

**The service is healthy but `/readyz` returns 503.** The task role cannot reach the corpus bucket.
The policy is scoped to one bucket and one prefix — confirm `corpusPrefix` matches where the sync
script actually uploaded.

**Readiness never passes and the logs mention the GitHub App.** With `cmsGitHubAppId` set, the stack
creates the App's secret but leaves it empty on purpose — the private key is written out of band.
Until it is, no installation token can be minted and the task correctly refuses to accept traffic.
See [the corpus repository guide](./corpus-repository.md).

**Ingestion completes but `/v1/search` finds nothing.** Check the model access from prerequisite 1,
and confirm `embeddingModelId` matches the dimension the index was created with. Changing the
embedding model requires recreating the index.
