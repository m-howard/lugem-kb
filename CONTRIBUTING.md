# Contributing to Lugem KB

Thanks for taking the time. This document covers what you need to know before opening a pull
request; the project-wide conventions live in [`AGENTS.md`](AGENTS.md).

## Prerequisites

| Tool                                               | Version               | Why                                          |
| -------------------------------------------------- | --------------------- | -------------------------------------------- |
| [Bun](https://bun.sh)                              | see `.bun-version`    | The only package manager.                    |
| Node.js                                            | see `.nvmrc` (24 LTS) | Docusaurus and some tooling shell out to it. |
| [Pulumi CLI](https://www.pulumi.com/docs/install/) | 3.226.0+              | Only if you touch `infra/`.                  |
| Docker                                             | any recent            | Only if you touch the image.                 |

**Bun is required.** There is one lockfile and it is `bun.lock` — please do not add
`pnpm-lock.yaml`, `package-lock.json` or `yarn.lock`. The reasoning is in
[ADR 0007](docs/adr/0007-single-lockfile-no-pnpm-parity.md), including what would make us revisit
it. If the Bun requirement is a genuine blocker for you, please open an issue — that is exactly
the report that ADR names as its revisit trigger.

```bash
bun install
```

## Before you open a pull request

```bash
bun run typecheck
bun run lint && bun run lint:md
bun run test:coverage    # must clear 80% on statements, lines, functions, branches
bun run docs:build       # fails on a broken link, on purpose
```

E2E needs a browser (`bunx playwright install chromium`) and then `bun run test:e2e`. If your
environment already ships a Chromium, point `PLAYWRIGHT_CHROMIUM_EXECUTABLE` at it instead.

## The rules that actually get pull requests sent back

### Tests ship with the code

If you change anything under a `src/`, include or update tests in the same pull request. Unit
tests live **beside** their source as `*.test.ts`; integration tests live in that workspace's
`tests/` folder; only cross-cutting Playwright specs go in the repo-root `tests/e2e/`.

The coverage gate measures logic, not resource wiring —
[ADR 0008](docs/adr/0008-coverage-gate-on-logic-only.md) explains the denominator. If you add
logic to a Pulumi module, extract it into a testable pure function rather than widening the
coverage `include`. `infra/pulumi/src/config.ts` (pure, tested) versus `read-config.ts`
(engine-bound, thin, untested by design) is the pattern to copy.

### Route order in the gateway

The static site handler is a catch-all and must stay mounted **last** in
`apps/gateway/src/app.ts`. Mounted earlier, it answers every API path with HTML and a 200 status —
health checks stay green and only a JSON client notices.
`apps/gateway/tests/integration/route-precedence.test.ts` guards this; if you add a route, add a
case there.

### Configuration fails closed

Anything that identifies a resource is required with no default. Errors name the offending
variable. See [ADR 0009](docs/adr/0009-fail-closed-configuration.md) before adding a config
option — "sensible default" is usually the wrong instinct here.

### Docs change with the code

Update the affected page in the same pull request. `docs/` is not just documentation — it is the
corpus the knowledge base indexes, so a stale page becomes a confidently wrong answer.

Architectural decisions get an ADR in `docs/adr/`, numbered sequentially, with context, the
decision, and its consequences. Say what the decision **costs**; an ADR that only lists benefits
is not helping the person who has to revisit it.

Every corpus page carries `owner` and `last_reviewed` frontmatter. Readers see `last_reviewed`
beside citations, which is what makes staleness visible in an answer rather than only on the page.

## Commits and branches

Conventional commits: `type(scope): subject`, imperative, lowercase, no trailing period, 72
characters or fewer.

```text
feat(gateway): add cursor pagination to the documents route
fix(infra): reject subnets outside the configured VPC during preview
docs(adr): record why the site is served from ECS
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `style`, `ci`.

Branch from `main` with a `feature/`, `fix/`, `chore/`, `refactor/` or `docs/` prefix. Keep pull
requests to one logical change — the review you want is the one where a reviewer can hold the
whole diff in their head.

## Style

Prettier and ESLint own formatting; do not hand-format. Two-space indent, single quotes, 100
columns. Beyond that: no magic numbers, no nested ternaries, at most three parameters, functions
under 50 lines, files under 500. The full list is in [`AGENTS.md`](AGENTS.md).

Comments explain **why**. The code already says what it does; a comment that repeats it will
be wrong within two refactors.

## Security

Please do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Code of conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
