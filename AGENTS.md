# Lugem Knowledge Base agent guide

> One liner

## File placement & repo-root hygiene

- **Test files**: ALL unit tests, integration tests, ecosystem tests, or Vitest files MUST strictly be placed within the `tests/` directory (e.g., `tests/unit/`, `tests/integration/`). NEVER create test files in the project root (`/`).
- **Scripts and utilities**: ALL maintenance, debugging, generation, or experimental scripts (`.cjs`, `.mjs`, `.js`, `.ts`) MUST be placed strictly inside one of the `scripts/` subfolders (`build/`, `dev/`, `check/`, `docs/`, `ad-hoc/`). One-shot or experimental code goes under `scripts/ad-hoc/`. NEVER dump loose scripts in the project root (`/`) or the top-level `scripts/` folder.

**The project root MUST ONLY contain:**

- Configuration files (`vitest.config.mts`, `playwright.config.ts`, `eslint.config.mjs`, `tsconfig*.json`, `.prettierrc`, `.markdownlint.jsonc`, `.editorconfig`)
- Dependency files (`package.json`, `bun.lock`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`)
- Documentation files (`README.md`, `CHANGELOG.md`, `LICENSE`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`)
- CI/CD files and ignore definitions (`.gitignore`, `.gitattributes`, `.dockerignore`, `.npmignore`, `.prettierignore`, `.markdownlintignore`, `.nvmrc`, `.bun-version`, `.env.example`)

When creating _any_ validation tests or one-off logic scripts, default to `scripts/ad-hoc/` or `tests/unit/` according to your goals. Do not pollute the `/` root context.

## Testing

Vitest is the only unit/integration runner; Playwright covers e2e. Scripts work under any
package manager — `bun run` is shown because it is the fastest.

| What              | Command                                                                     |
| ----------------- | --------------------------------------------------------------------------- |
| Unit tests        | `bun run test:unit`                                                         |
| Integration tests | `bun run test:integration`                                                  |
| Everything        | `bun run test`                                                              |
| Single file       | `bun run vitest run tests/unit/your-file.test.ts`                           |
| Watch mode        | `bun run test:watch`                                                        |
| E2E (Playwright)  | `bun run test:e2e`                                                          |
| Coverage gate     | `bun run test:coverage` (60/60/60/60 — statements/lines/functions/branches) |
| Coverage report   | `bun run coverage:report`                                                   |

**PR rule**: If you change production code in `src/`, you must include or update tests in the same PR.

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
- Consistent indentation: 4 spaces (JS/TS).
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
