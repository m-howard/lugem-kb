---
title: 0019 — A content check that speaks to authors
sidebar_label: 0019 Content quality gates
owner: platform
last_reviewed: 2026-08-10
---

# ADR 0019 — A content check that speaks to authors

- **Date:** 2026-08-10
- **Status:** Accepted

## Context

R13 asks for three things: frontmatter validated in CI with a missing `owner` failing the check,
internal links checked with a broken link failing the check, and failures that "surface as a
readable message, not a raw log".

The first two are, on the face of it, already true. `docusaurus.config.ts` sets
`onBrokenLinks: 'throw'`, `onBrokenAnchors: 'throw'` and `onBrokenMarkdownLinks: 'throw'`, and CI
builds the site on every pull request. A broken link already fails.

The third is not true at all, and it is the one that decides whether Phase 3's pilot works. An
author who submitted a page through the CMS at `/publisher` has never seen this repository. They have a
pull request with a red X on it. Behind the X is a job named "Build" whose log ends in a Docusaurus
exception, several hundred lines down, in terms — `Docs markdown link couldn't be resolved` against
a source file path — that assume they know where the corpus lives. Nothing routes them back to the
sentence they typed.

There is also a plainer gap: nothing checks frontmatter at all. Docusaurus is happy with a page
that has no `owner`, and so is the build. The field is only load-bearing later — in review routing,
and in the gap report that names the owning team — so a page missing one fails silently, months
after it was written.

## Decision

**A dedicated corpus check that runs before the build and reports to the author.**

1. **`bun run docs:check`,** its own CI job named "Content quality gates". It walks `docs/`,
   validates frontmatter, checks that every page matches a `CODEOWNERS` entry, and resolves every
   relative markdown link and `#anchor`. It needs no site build, so it fails in seconds.
2. **The message is the feature.** Three renderings of the same `Problem[]`: a grouped terminal
   report, `::error` annotations pinned to the line in the diff, and a markdown table posted as a
   sticky pull request comment. The comment is the one that matters — it is where a CMS author
   meets the failure. It is updated rather than duplicated on each push, and rewritten to say the
   problems are gone when a later push fixes them.
3. **Required fields are `title`, `owner` and `last_reviewed`, and nothing else is rejected.**
   Docusaurus accepts a long tail of optional keys and an allowlist would have to grow every time
   an author reaches for a documented feature. `last_reviewed` must be a real calendar date, so
   `2026-02-30` fails: it is displayed beside every citation, and a page whose staleness is
   unreadable is worse than one with no date.
4. **Ownership is checked against `CODEOWNERS`, reusing `ownersFor`** — the same matcher the gap
   report uses, so the two can never disagree about who owns a page. `.github/CODEOWNERS` says in
   its own header that a page with no entry routes to nobody; this is what notices.
5. **The Docusaurus build keeps throwing.** This check does not replace it. It resolves relative
   markdown links and skips external URLs and site-absolute paths, which an offline check cannot
   speak to; the build still catches those. Two nets, different holes.
6. **The validators are pure and measured.** `frontmatter.ts`, `links.ts`, `ownership.ts` and
   `problem-report.ts` join `codeowners.ts` in the coverage gate, for the reason
   [ADR 0008](0008-coverage-gate-on-logic-only.md) gives: they decide whether a page may be
   published. The walker and the runner beside them are I/O and stay out.

## Consequences

**A second link checker to keep honest.** It can disagree with Docusaurus — passing something the
build rejects, most likely, since it checks a narrower set. That direction is the safe one: the
build still fails, and the author gets the worse message for that case only.

**Markdown parsing without a markdown parser.** `findLinks` strips fenced and inline code and then
matches link syntax; `headingSlugs` reimplements `github-slugger`'s rules. Both are approximations
of what Docusaurus does, and both are unit-tested against the shapes this corpus actually contains.
Pulling in remark to be exact would add a parser and its plugin surface to a check whose whole
value is that it is fast and legible.

**The comment needs `pull-requests: write`.** Granted to that job alone, and the step is guarded on
the head repository being this one — a fork's token cannot write, and asking it to would fail the
job for a reason the contributor cannot fix.

## Alternatives considered

**Rely on the Docusaurus build alone.** Meets two criteria of three, and misses the one the pilot
depends on. It also cannot check frontmatter.

**`remark-lint` with a preset.** A real parser and a large rule set, most of which is style this
project has no opinion on, and no answer for ownership or for the pull request comment.

**A frontmatter schema in Zod, shared with the gateway.** Tempting — the gateway already reads
these fields. But it reads one field at a time at request time and needs no line numbers, and
sharing a module across the `apps/` and `scripts/` boundary for two dozen lines of validation would
couple the corpus checker to the service's build. The relationship is recorded in both docstrings
instead.
