import { type Problem } from './problem';

/** Frontmatter is the leading `---` fenced block. A `---` anywhere else is a horizontal rule. */
const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

/** The line the block's first field sits on: line 1 is the opening `---`. */
const FIRST_FIELD_LINE = 2;

/**
 * Fields every corpus page must carry.
 *
 * `owner` is the one requirements.md R13 names explicitly, and it is the one that matters most:
 * `.github/CODEOWNERS` turns it into an actual review request, and the gap report names it when a
 * reader's question finds no answer. A page without one is unowned in every sense.
 *
 * `last_reviewed` is required because retrieval displays it beside every citation — a page with no
 * date is a page whose staleness is invisible in chat as well as on the page.
 */
const REQUIRED_FIELDS = ['title', 'owner', 'last_reviewed'] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_LENGTH = 10;

export interface FrontmatterField {
  readonly value: string;
  /** 1-based line in the whole file, so an annotation lands on the offending field. */
  readonly line: number;
}

export interface ParsedFrontmatter {
  /** False when the file has no leading `---` block at all. */
  readonly present: boolean;
  readonly fields: ReadonlyMap<string, FrontmatterField>;
}

/**
 * Reads a page's frontmatter into fields with line numbers.
 *
 * A sibling of `apps/gateway/src/kb/frontmatter.ts`, which answers a different question — that one
 * reads a single named field at request time and needs no positions. Neither is a YAML parser, and
 * for the same reason: every page in this corpus carries flat `key: value` frontmatter, and a YAML
 * dependency would add a parser, its own escaping rules and a supply-chain edge to read one line.
 * The cost is that nested keys, multi-line scalars and anchors are invisible here.
 *
 * @param body - The whole file. Only the leading fenced block is examined.
 * @returns Whether a block was present, and each top-level field found in it.
 *
 * @example
 * ```ts
 * parseFrontmatter('---\ntitle: Leave policy\nowner: people\n---\n# Leave');
 * // → { present: true, fields: Map { 'title' => { value: 'Leave policy', line: 2 }, ... } }
 * ```
 */
export function parseFrontmatter(body: string): ParsedFrontmatter {
  const block = FRONTMATTER_BLOCK.exec(body)?.[1];
  if (block === undefined) {
    return { present: false, fields: new Map() };
  }

  const fields = new Map<string, FrontmatterField>();

  block.split(/\r?\n/).forEach((text, index) => {
    const separator = text.indexOf(':');
    if (separator === -1) {
      return;
    }

    const key = text.slice(0, separator).trim();
    // Indented lines belong to a nested structure this parser does not model; a comment is not a
    // field. Skipping both is honest — claiming to have read them would be worse.
    if (key === '' || key !== text.slice(0, separator) || key.startsWith('#')) {
      return;
    }

    // Only the first colon splits: `title: 0005 — Bedrock: the sequel` keeps its colon.
    const value = text
      .slice(separator + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');

    fields.set(key, { value, line: FIRST_FIELD_LINE + index });
  });

  return { present: true, fields };
}

/** `2026-02-30` matches the pattern and is not a day. Round-tripping is what catches it. */
function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, ISO_DATE_LENGTH) === value
  );
}

/**
 * Checks one page's frontmatter against what the corpus requires (requirements.md R13).
 *
 * Unknown keys are deliberately **not** rejected. Docusaurus accepts a long tail of them —
 * `slug`, `description`, `pagination_next`, `hide_table_of_contents` and more — and an allowlist
 * would have to be extended every time an author reaches for a documented feature, which turns a
 * quality gate into an obstacle. This checks that what must be there is there and is well formed.
 *
 * @param parsed - Output of {@link parseFrontmatter}.
 * @param options - `file` is the repository-relative path, used in the messages.
 * @returns One problem per failure, in field order. Empty when the page is fine.
 *
 * @example
 * ```ts
 * validateFrontmatter(parseFrontmatter(body), { file: 'docs/leave.md' });
 * // → [{ rule: 'frontmatter-required-field', message: 'Add an `owner`: ...', ... }]
 * ```
 */
export function validateFrontmatter(
  parsed: ParsedFrontmatter,
  options: { readonly file: string },
): readonly Problem[] {
  const { file } = options;

  if (!parsed.present) {
    return [
      {
        file,
        line: 1,
        rule: 'frontmatter-missing',
        message:
          'This page has no frontmatter. Start it with a `---` block holding ' +
          `${REQUIRED_FIELDS.join(', ')}.`,
      },
    ];
  }

  const problems: Problem[] = [];

  for (const field of REQUIRED_FIELDS) {
    const found = parsed.fields.get(field);
    if (found === undefined || found.value === '') {
      problems.push({
        file,
        line: found?.line ?? 1,
        rule: 'frontmatter-required-field',
        message: `Add \`${field}\` to this page's frontmatter. ${reasonFor(field)}`,
      });
    }
  }

  const reviewed = parsed.fields.get('last_reviewed');
  if (reviewed !== undefined && reviewed.value !== '' && !isCalendarDate(reviewed.value)) {
    problems.push({
      file,
      line: reviewed.line,
      rule: 'frontmatter-date',
      message:
        `\`last_reviewed\` is "${reviewed.value}", which is not a date. ` +
        'Write it as YYYY-MM-DD, for example 2026-08-10.',
    });
  }

  return problems;
}

/** Why the field is required, in the author's terms rather than the schema's. */
function reasonFor(field: (typeof REQUIRED_FIELDS)[number]): string {
  switch (field) {
    case 'title':
      return 'It names the page in the sidebar and in search results.';
    case 'owner':
      return 'It names the team a review request and a documentation gap are routed to.';
    case 'last_reviewed':
      return 'It is shown beside every citation, so readers can see how current the page is.';
  }
}
