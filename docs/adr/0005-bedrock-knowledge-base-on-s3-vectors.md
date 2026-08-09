---
title: 0005 — Bedrock knowledge base on S3 Vectors
sidebar_label: 0005 KB on S3 Vectors
owner: platform
last_reviewed: 2026-08-09
---

# ADR 0005 — Bedrock knowledge base on S3 Vectors

- **Date:** 2026-08-09
- **Status:** Accepted

## Context

A Bedrock knowledge base needs a vector store. The provider supports OpenSearch Serverless,
OpenSearch managed clusters, RDS with pgvector, Pinecone, MongoDB Atlas, Redis Enterprise,
Neptune Analytics, and S3 Vectors.

For an open-source reference implementation the deciding factor is not throughput — it is what the
thing costs when nobody is using it. A repository whose demo stack bills hundreds of dollars a
month is a repository nobody deploys twice.

| Option                     | Idle cost         | Notes                                                   |
| -------------------------- | ----------------- | ------------------------------------------------------- |
| OpenSearch Serverless      | **~$700/month**   | 2 OCU minimum, billed whether or not it is queried.     |
| RDS with pgvector          | ~$15/month and up | Cheapest instance, plus storage and a VPC to put it in. |
| Pinecone / MongoDB / Redis | varies            | Third-party account, credentials in Secrets Manager.    |
| **S3 Vectors**             | **~$0**           | Pay per vector stored and per query.                    |

## Decision

S3 Vectors, provisioned entirely by Pulumi:

```text
aws.s3.VectorsVectorBucket          the store
aws.s3.VectorsIndex                 float32, 1024 dimensions, cosine
aws.bedrock.AgentKnowledgeBase      type VECTOR, storage type S3_VECTORS
aws.bedrock.AgentDataSource         S3, scoped by inclusionPrefixes
```

Verified against `@pulumi/aws@7.41.0`'s shipped type definitions, so no CloudFormation escape
hatch is needed.

The embedding model is `amazon.titan-embed-text-v2:0`, whose 1024 dimensions the index must match
exactly. `infra/pulumi/src/config.ts` holds the model-to-dimension map and refuses an unknown
model rather than guessing — a mismatched index fails ingestion rather than degrading, and it
fails well after `pulumi up` reports success.

## Consequences

- The demo stack is affordable to leave running, which is the whole point.
- **S3 Vectors is in fewer regions than S3.** The stack refuses to preview in a region it does not
  recognise, naming `aws:region`. `allowUnverifiedRegion` is the documented override for a region
  AWS added after the constant was last checked — better than a fork.
- **Bedrock model access is a manual prerequisite.** It is per-account, per-region, and off by
  default. Without it the stack deploys clean and ingestion fails.
- Changing the embedding model means recreating the index, because the dimension is fixed at
  creation.
- If query latency or filtering ever outgrows S3 Vectors, the storage configuration is one block
  in `knowledge-base.ts`. Nothing else in the stack knows which store is behind the knowledge base.
