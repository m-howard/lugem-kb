/** Frontmatter is the leading `---` fenced block. A `---` anywhere else is a horizontal rule. */
const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

/**
 * Reads one top-level field out of a markdown file's frontmatter.
 *
 * Deliberately not a YAML parser. Every page in this corpus carries flat `key: value` frontmatter
 * — `title`, `owner`, `last_reviewed` — and pulling in a YAML dependency to read one line would
 * add a parser, its own escaping rules, and a supply-chain edge for no gain. The cost of that
 * choice is real and worth naming: nested keys, multi-line scalars, and anchors are invisible to
 * this function. It returns `undefined` for them rather than a wrong answer.
 *
 * @param body - The file contents. Only the leading fenced block is examined.
 * @param field - The top-level key to read.
 * @returns The trimmed value with surrounding quotes removed, or `undefined` if absent.
 *
 * @example
 * ```ts
 * readFrontmatterField('---\ntitle: ADR 0005\nlast_reviewed: 2026-08-09\n---\n# Body', 'last_reviewed');
 * // → '2026-08-09'
 * ```
 */
export function readFrontmatterField(body: string, field: string): string | undefined {
  const block = FRONTMATTER_BLOCK.exec(body)?.[1];
  if (block === undefined) {
    return undefined;
  }

  for (const line of block.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1 || line.slice(0, separator).trim() !== field) {
      continue;
    }
    // Only the first colon splits: `title: 0005 — Bedrock: the sequel` keeps its colon.
    const value = line.slice(separator + 1).trim();
    return value === '' ? undefined : value.replace(/^(['"])(.*)\1$/, '$2');
  }

  return undefined;
}
