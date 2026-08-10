export interface CodeownersRule {
  readonly pattern: string;
  readonly owners: readonly string[];
}

/** `*` matches within a path segment; `**` crosses them. Everything else is escaped literally. */
const SPECIAL_CHARACTERS = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']);

/**
 * Patterns this parser will not guess at.
 *
 * GitHub's format allows `?` and character classes. Nothing in this repository uses them, and a
 * near-miss match would attribute a documentation gap to the wrong team — which is worse than
 * attributing it to nobody. Same stance `kb/frontmatter.ts` takes about nested YAML.
 */
const UNSUPPORTED = /[?[\]]/;

function toRegExp(pattern: string): RegExp | undefined {
  if (UNSUPPORTED.test(pattern)) {
    return undefined;
  }

  const anchored = pattern.startsWith('/');
  const body = anchored ? pattern.slice(1) : pattern;
  const isDirectory = body.endsWith('/');
  const trimmed = isDirectory ? body.slice(0, -1) : body;

  // Scanned character by character rather than chained `replace` calls. Substituting `**` first
  // and `*` second needs a sentinel to keep them apart, and a sentinel that can also appear in a
  // path is a bug waiting for the right filename.
  let escaped = '';
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index] ?? '';
    if (char !== '*') {
      escaped += SPECIAL_CHARACTERS.has(char) ? `\\${char}` : char;
      continue;
    }
    if (trimmed[index + 1] === '*') {
      escaped += '.*';
      index += 1;
    } else {
      escaped += '[^/]*';
    }
  }

  // A directory pattern matches everything beneath it. A file pattern matches the path itself, or
  // anything beneath it if it turns out to name a directory — GitHub treats `/docs` like `/docs/`.
  const suffix = isDirectory ? '/.*' : '(?:/.*)?';
  const prefix = anchored ? '' : '(?:.*/)?';

  return new RegExp(`^${prefix}${escaped}${suffix}$`);
}

/**
 * Reads a CODEOWNERS file into rules, in file order.
 *
 * Comments and blank lines are dropped. The first whitespace-separated field is the pattern and
 * the rest are owners; an entry with a pattern but no owner is kept, because in GitHub's format
 * that deliberately means "this path has no owner" and overrides anything earlier.
 *
 * @param contents - The raw file.
 * @returns One rule per entry, in the order they appeared.
 *
 * @example
 * ```ts
 * parseCodeowners('/docs/ @docs-team\n');
 * // → [{ pattern: '/docs/', owners: ['@docs-team'] }]
 * ```
 */
export function parseCodeowners(contents: string): readonly CodeownersRule[] {
  const rules: CodeownersRule[] = [];

  for (const line of contents.split('\n')) {
    const withoutComment = line.split('#')[0] ?? '';
    const fields = withoutComment
      .trim()
      .split(/\s+/)
      .filter((field) => field !== '');
    const [pattern, ...owners] = fields;
    if (pattern === undefined || pattern === '') {
      continue;
    }
    rules.push({ pattern, owners });
  }

  return rules;
}

/**
 * Resolves the owners of a repository path.
 *
 * **Last match wins**, which is the rule most implementations get backwards and the one that
 * matters here: `/docs/` and `/docs/adr/` both match an ADR, and only the later, more specific
 * entry names the team that should actually hear about it.
 *
 * @param repoPath - Repository-root-relative path, without a leading slash, e.g. `docs/people/leave.md`.
 * @param rules - Rules from {@link parseCodeowners}, in file order.
 * @returns The matching owners, or an empty list when nothing matches or the match disowns the path.
 *
 * @example
 * ```ts
 * ownersFor('docs/adr/0006-x.md', parseCodeowners(file));
 * // → ['@m-howard'] — from `/docs/adr/`, not from the earlier `/docs/`
 * ```
 */
export function ownersFor(repoPath: string, rules: readonly CodeownersRule[]): readonly string[] {
  const normalised = repoPath.replace(/^\/+/, '');
  let owners: readonly string[] = [];

  for (const rule of rules) {
    const expression = toRegExp(rule.pattern);
    if (expression?.test(normalised) === true) {
      owners = rule.owners;
    }
  }

  return owners;
}
