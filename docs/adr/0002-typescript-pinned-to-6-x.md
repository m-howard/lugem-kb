---
title: 0002 — TypeScript pinned to 6.x
sidebar_label: 0002 TypeScript 6.x
owner: platform
last_reviewed: 2026-08-09
---

# ADR 0002 — TypeScript pinned to 6.x

- **Date:** 2026-08-09
- **Status:** Accepted

## Context

`typescript@latest` is **7.0.2** — the native compiler port, and substantially faster.

`typescript-eslint@8.66.0` is the only release line supporting `eslint@10`, and it declares:

```json
"peerDependencies": { "typescript": ">=4.8.4 <6.1.0" }
```

TypeScript 7 is outside that range. Installing it makes type-aware linting fail on install, not at
some later point where the cause would be obvious.

This project leans on type-aware rules more than most: the Pulumi program is where a
`Promise<Output<string>>` silently used as a `string` produces a stack that deploys and is wrong.

## Decision

Pin `typescript` to `~6.0.3` — the newest release inside the supported range.

Do not upgrade to 7.x until `typescript-eslint` publishes a line that accepts it. The pin is
recorded here so the next person to run `bun update` and see 7.x available knows it is a
constraint, not neglect.

## Consequences

- Type-aware linting keeps working.
- Compile times are slower than TypeScript 7 would give. Acceptable at this size.
- **Revisit trigger:** `typescript-eslint` publishes a version whose peer range includes 7.x. At
  that point upgrade both together, in one change.
