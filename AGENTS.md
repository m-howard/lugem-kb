# Lugem Knowledge Base agent guide

> Documentation that publishes itself and answers questions: a Docusaurus corpus in git, a Bun
> service on ECS, and a Bedrock knowledge base — all deployed by Pulumi into an existing VPC.

## Workspace layout

This is a Bun workspace monorepo. Every file belongs to exactly one workspace or to the root.

| Path            | Holds                                                                        |
| --------------- | ---------------------------------------------------------------------------- |
| `apps/docs/`    | Docusaurus site. Its content root is repo-root `docs/`, not a local copy.    |
| `apps/gateway/` | The Bun + Hono service deployed to ECS. Owns its own `Dockerfile`.           |
| `infra/pulumi/` | The Pulumi program. `runtime: bun` — no ts-node, no build step.              |
| `docs/`         | The corpus. Published by `apps/docs` and synced to S3 for ingestion.         |
| `docs/assets/`  | The corpus's non-prose half. Published as static site assets, never indexed. |
| `scripts/`      | Repo-level tooling, in a subfolder (see below).                              |
| `tests/e2e/`    | Playwright only.                                                             |

## File placement & repo-root hygiene

- **Test files**: unit tests live **beside the code they test** as `*.test.ts` (e.g.
  `apps/gateway/src/kb/key-policy.test.ts`). Integration tests live in that workspace's own
  `tests/` folder (e.g. `apps/gateway/tests/integration/`). Only cross-cutting Playwright specs go
  in the repo-root `tests/e2e/`. NEVER create test files in the project root (`/`).
- **Pulumi components**: every resource group is a `ComponentResource` subclass, one per file, in
  `infra/pulumi/src/components/`. Pure, testable logic stays out of them — the split is
  `config.ts` (pure, tested) versus `read-config.ts` (engine-bound, thin). See
  [ADR 0010](docs/adr/0010-custom-components-for-resource-groups.md).
- **Scripts and utilities**: ALL maintenance, debugging, generation, or experimental scripts
  (`.cjs`, `.mjs`, `.js`, `.ts`) MUST be placed strictly inside one of the `scripts/` subfolders
  (`build/`, `dev/`, `check/`, `docs/`, `ad-hoc/`). One-shot or experimental code goes under
  `scripts/ad-hoc/`. NEVER dump loose scripts in the project root (`/`) or the top-level `scripts/`
  folder.

- **Images and other binary assets**: uploads from the CMS live in `docs/assets/media/` and nowhere
  else. `apps/docs` publishes `docs/assets/` as a static directory, so a file there is served from the
  site root under its own folder name (`docs/assets/media/x.png` → `/media/x.png`), and the gateway
  confines uploads to the same folder via `CMS_MEDIA_FOLDER`. Changing one without the other produces
  images the site cannot serve — see
  [ADR 0021](docs/adr/0021-images-travel-with-the-draft.md).

**The project root MUST ONLY contain:**

- Configuration files (`vitest.config.mts`, `playwright.config.ts`, `eslint.config.mjs`, `tsconfig*.json`, `.prettierrc`, `.markdownlint.jsonc`, `.editorconfig`)
- Dependency files (`package.json`, `bun.lock`, `.npmrc`)
- Documentation files (`README.md`, `CHANGELOG.md`, `LICENSE`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`)
- CI/CD files and ignore definitions (`.gitignore`, `.gitattributes`, `.dockerignore`, `.npmignore`, `.prettierignore`, `.markdownlintignore`, `.nvmrc`, `.bun-version`, `.env.example`)

When creating _any_ one-off logic script, default to `scripts/ad-hoc/`. Do not pollute the `/` root
context.

## Package manager

**Bun only.** One lockfile, `bun.lock`. Do not add `pnpm-lock.yaml`, `package-lock.json`, or
`yarn.lock`, and do not introduce a second workspace manifest — see
[ADR 0007](docs/adr/0007-single-lockfile-no-pnpm-parity.md). Pulumi runs the infra program on Bun
natively, so Node is a tooling dependency only.

## Testing

Vitest is the only unit/integration runner; Playwright covers e2e.

| What              | Command                                                                     |
| ----------------- | --------------------------------------------------------------------------- |
| Unit tests        | `bun run test:unit`                                                         |
| Integration tests | `bun run test:integration`                                                  |
| Everything        | `bun run test`                                                              |
| Single file       | `bun run vitest run apps/gateway/src/kb/key-policy.test.ts`                 |
| Watch mode        | `bun run test:watch`                                                        |
| E2E (Playwright)  | `bun run test:e2e`                                                          |
| Coverage gate     | `bun run test:coverage` (80/80/80/80 — statements/lines/functions/branches) |

The coverage gate measures `apps/gateway/src/**`, `infra/pulumi/src/config.ts`,
`infra/pulumi/src/github-config.ts` and `scripts/docs/codeowners.ts` — the code that holds logic.
Declarative Pulumi resource wiring is excluded from the denominator so the number means something;
see [ADR 0008](docs/adr/0008-coverage-gate-on-logic-only.md). Most of `scripts/` is I/O
orchestration and stays out; the CODEOWNERS parser is in because it decides who hears about a
documentation gap.

**PR rule**: If you change production code under any `src/`, you must include or update tests in
the same PR.

## Coding Style Rules

### Naming Conventions

- Variables and functions: camelCase (JS/TS), snake_case (Python/Rust/Go).
- Classes and types: PascalCase in all languages.
- Constants: UPPER_SNAKE_CASE for true constants, camelCase for derived values.
- Booleans: prefix with `is`, `has`, `can`, `should` (e.g., `isActive`, `hasPermission`).
- Files: kebab-case for most files, PascalCase for React components.

### File Organization

- One exported concept per file. If a file has multiple unrelated exports, split it.
- Group files by feature (not by type) in larger projects.
- Keep files under 500 lines. If longer, extract sub-modules.
- Index files should only re-export, never contain logic.

### Import Ordering

1. Standard library / built-in modules.
2. External packages (node_modules, pip packages).
3. Internal absolute imports (from project root).
4. Relative imports (from current directory).
5. Type-only imports last.

- Blank line between each group. Alphabetical within each group.

### Code Clarity

- No magic numbers. Extract named constants with descriptive names.
- No nested ternaries. Use if/else or extract to a function.
- Maximum function length: 50 lines. If longer, extract helpers.
- Maximum function parameters: 3. Use an options object for more.
- Remove all dead code. Do not comment out code "for later."

### Formatting

- Use the project's formatter (Prettier, Black, gofmt, rustfmt). Do not manually format.
- Consistent indentation: 2 spaces (JS/TS). Pulumi resource arguments nest deeply, and at a
  100-character line budget a wider indent costs more than it buys.
- Trailing commas in multi-line structures (JS/TS).
- No trailing whitespace. Files end with a single newline.

## Documentation Rules

### What to Document

- Write and update end user docs for features changes
- Write platform operator docs when needed
- Public API functions: parameters, return types, error conditions, examples.
- Architecture decisions: why a particular approach was chosen (ADRs).
- Setup and installation: prerequisites, steps, common issues.
- Configuration: all options, defaults, environment variables.
- Non-obvious behavior: edge cases, gotchas, workarounds.

### What Not to Document

- Obvious code (getters, setters, simple wrappers).
- Implementation details that change frequently.
- Anything the type system already expresses.
- Temporary workarounds without a tracking issue.

### Keep Docs Current

- Update documentation in the same PR that changes the code.
- Review docs in code review. Stale docs are worse than no docs.
- Keep CLAUDE.md or AGENTS.md updated with current project context.

### Documentation Formats

- Inline code comments: explain **why**, not what. One line, placed above the code.
- JSDoc/docstrings: for public APIs. Include parameters, returns, throws, and an example.
- README: installation, quick start, configuration, contribution guidelines.
- CLAUDE.md: project context, conventions, build commands, key architecture decisions.
- ADRs: date, status, context, decision, consequences. Store in `docs/adr/`.

### Style Guidelines

- Use concrete examples, not abstract descriptions.
- Write for the reader who will maintain this code in 6 months.
- Use consistent terminology. Define domain terms in a glossary if needed.
- Keep sentences short. One idea per paragraph.
- Use code blocks with language tags for syntax highlighting.
- Use tables for option lists, comparison matrices, and configuration references.

### README Structure

1. Project name and short description.
2. Installation / quick start (copy-paste ready).
3. Usage examples (the most common use case first).
4. Configuration reference.
5. Contributing guidelines.
6. License.

## Git Workflow

### Commit Messages

- Follow conventional commits: `type(scope): subject`.
- Types: feat, fix, refactor, docs, test, chore, perf, style, ci.
- Subject line: imperative mood, lowercase, no period, max 72 characters.
- Body: explain why, not what. Wrap at 80 characters.
- Reference issues: `Closes #123` or `Relates to #456`.

### Branching

- Create feature branches from main.
- Use prefixes: `feature/`, `fix/`, `chore/`, `refactor/`, `docs/`.
- Keep branches short-lived. Merge within 1-3 days.
- Delete branches after merging.

### Pull Requests

- One logical change per PR. Do not bundle unrelated changes.
- Write a description explaining the motivation, not just the changes.
- Include a test plan describing how to verify the change.
- Request review from at least one person.
- Address all review comments before merging.

### Merge Strategy

- Squash merge for feature branches (clean history).
- Merge commit for release branches (preserve history).
- Never force push to main or shared branches.
- Rebase feature branches on main before merging to resolve conflicts.

### Safety Rules

- Never commit secrets, credentials, or API keys.
- Never commit large binary files. Use Git LFS if needed.
- Never commit generated files (dist/, build/, node_modules/).
- Always review `git diff --cached` before committing.
- Run tests before pushing. If CI fails, fix before merging.

### Tags and Releases

- Use semantic versioning: MAJOR.MINOR.PATCH.
- Tag releases on main: `git tag -a v1.2.3 -m "Release 1.2.3"`.
- Write release notes summarizing changes since last release.
