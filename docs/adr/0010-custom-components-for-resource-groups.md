---
title: 0010 — Custom components for resource groups
sidebar_label: 0010 Custom components
owner: platform
last_reviewed: 2026-08-09
---

# ADR 0010 — Custom components for resource groups

- **Date:** 2026-08-09
- **Status:** Accepted

## Context

The Pulumi program started as a flat wiring script: nine `createX(name, args)` factories, called in
order from `index.ts`, each returning a bag of `Output`s. It worked, and for a stack of thirty
resources that is not nothing. But the shape had started to cost.

Every resource hung directly off the stack, so `pulumi preview` printed thirty siblings with no
indication of which belonged together. Nothing was reusable: a second environment meant calling the
same nine functions again with a different prefix and hoping the argument objects stayed in step.
Two modules passed live resource objects across the boundary — `load-balancer.ts` handed its
security group and target group to `ecs-service.ts` — which is a tighter coupling than the two
`Output`s actually needed.

The lint rules had started to push back too. `max-params: 3` had already forced
`createTaskDefinition` to take a `{ args, logGroup }` wrapper whose only purpose was to smuggle a
fourth value past the rule, because a free function has no `this` to read from.

And the tagging was a lie of omission: exactly one resource in the program carried a tag, so nothing
in the account could be attributed to this stack by anything other than its name prefix.

## Decision

Every resource group is a `pulumi.ComponentResource` subclass in `infra/pulumi/src/components/`,
with a `lugem:<module>:<Type>` type token, `{ parent: this }` on every child, and
`registerOutputs()` at the end of the constructor. Public fields are `readonly Output<T>` — never
live resource objects.

`iam.ts` is gone; its two roles belong to `GatewayService`, the only thing that ever used them.
`network.ts` stays a plain function, because it creates no resources and a component that registers
nothing would be ceremony.

`index.ts` remains the composition root and keeps its nine existing output names unchanged. It gains
an explicit `aws.Provider` carrying `defaultTags`, so `Project`, `Stack` and `ManagedBy` land on
every resource without thirty individual `tags:` blocks.

Every child that existed before this change also carries `aliases: [{ parent:
pulumi.rootStackResource }]`. A resource's URN includes its parent chain, so adopting a parent
renames all of them; without the alias, an already-deployed stack reads the refactor as thirty
deletions and thirty creations — including the corpus bucket and the vector index.

## Consequences

- `pulumi preview` shows a tree instead of a list, and a component's children move, update and
  delete together.
- The first preview after this change is still not empty. Aliases cover the renames, but moving from
  the ambient default provider to an explicit one shows as an update on every resource. Read that
  diff before accepting it, and confirm it contains no `replace` operations.
- `reparentedChild()` is for resources that predate this ADR only. Using it on something new records
  a URN that never existed — a lie in the state file that the next reader has to disprove.
- Components are constructed, not called, so `no-new` stays off for `infra/pulumi/**` and
  constructors are bound by `max-lines-per-function` at 80. Two components needed private helpers to
  stay under it; that is the rule working, not fighting it.
- Nothing here is covered by the test suite, and that has not changed —
  [ADR 0008](0008-coverage-gate-on-logic-only.md) still holds that the honest test for resource
  wiring is `pulumi preview`.
