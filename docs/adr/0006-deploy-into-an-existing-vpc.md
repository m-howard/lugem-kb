---
title: 0006 — Deploy into an existing VPC
sidebar_label: 0006 Existing VPC
owner: platform
last_reviewed: 2026-08-09
---

# ADR 0006 — Deploy into an existing VPC

- **Date:** 2026-08-09
- **Status:** Accepted

## Context

Most demo stacks create their own VPC. It makes the quick start shorter and the teardown clean.

It also makes the stack useless to the organisations most likely to adopt it. Internal
documentation lives behind an internal network, and networking is usually owned by a different team
than the one deploying an application. A stack that insists on making its own VPC cannot be
deployed at all in those places, or gets forked and diverges.

## Decision

The stack consumes an existing VPC and never creates one. `vpcId`, `privateSubnetIds` and
`publicSubnetIds` are required configuration with no defaults.

`infra/pulumi/src/network.ts` looks up the VPC and asserts every configured subnet actually belongs
to it, failing during `preview` with the offending subnet IDs named.

## Consequences

- The stack is deployable into a network someone else governs, which is where it needs to work.
- Quick start needs three values the user must fetch first. `Pulumi.dev.yaml.example` and
  [Deploying to AWS](../deploying-to-aws.md) both spell out which.
- **Subnet membership is verified; routing is not.** Tasks run in private subnets with no public
  IP, so they need a NAT gateway or VPC endpoints for S3, Bedrock, ECR and CloudWatch Logs. Getting
  that wrong shows up as tasks that start and immediately stop with no application logs — the
  troubleshooting section in the deployment guide names this symptom.
- Teardown does not remove the VPC, because the stack did not create it.

## Why validate rather than trust

AWS accepts a foreign subnet in some API calls and rejects it in others, so the error tends to
surface several resources later, attached to something unrelated. Checking membership up front
turns a confusing mid-`up` failure into a preview-time message naming the subnet.
