import { posix } from 'node:path';

import { type Problem } from './problem';

/** `](target)` or `](target "title")`. The target stops at whitespace or the closing bracket. */
const INLINE_LINK = /\]\(\s*([^)\s]*)\s*(?:"[^"]*"|'[^']*')?\s*\)/g;

/** A reference definition: `[label]: target`, at the start of a line. */
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:[ \t]*(\S+)/;

/** An opening or closing code fence, indented up to three spaces as CommonMark allows. */
const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})/;

const ATX_HEADING = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;

/** `http:`, `mailto:` and friends. An offline checker cannot speak to whether they resolve. */
const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

const MARKDOWN_EXTENSIONS = ['.md', '.mdx'];

export interface Link {
  /** The raw target, fragment included. */
  readonly target: string;
  /** 1-based line in the whole file. */
  readonly line: number;
}

export interface CorpusPage {
  /** Repository-root-relative, POSIX-separated, e.g. `docs/adr/0004-pulumi-with-bun-runtime.md`. */
  readonly file: string;
  readonly body: string;
}

/**
 * Blanks out code, keeping the line count.
 *
 * Every guide in this corpus contains fenced examples, and several of them contain markdown that
 * is being *shown* rather than followed. Checking those would fail the build over a deliberate
 * illustration. Lines are replaced rather than removed so reported line numbers still match the
 * file an author opens.
 */
function withoutCode(body: string): string {
  let fence: string | undefined;

  return body
    .split(/\r?\n/)
    .map((line) => {
      const marker = CODE_FENCE.exec(line)?.[1];

      if (fence === undefined) {
        if (marker !== undefined) {
          fence = marker;
        }
        return marker === undefined ? line.replace(/`[^`]*`/g, '') : '';
      }

      // A fence only closes on the same character, and only when it is at least as long as the
      // one that opened it — otherwise ```` ``` ```` inside a ````` ```` ````` block ends it early.
      if (marker?.startsWith(fence) === true) {
        fence = undefined;
      }
      return '';
    })
    .join('\n');
}

/**
 * Every link target on a page, with the line it appears on.
 *
 * Code is stripped first, so an example link inside a fenced block is not treated as a claim about
 * the corpus.
 *
 * @param body - The whole file.
 * @returns One entry per link, in document order.
 *
 * @example
 * ```ts
 * findLinks('See [the guide](./getting-started.md#prerequisites).');
 * // → [{ target: './getting-started.md#prerequisites', line: 1 }]
 * ```
 */
export function findLinks(body: string): readonly Link[] {
  const links: Link[] = [];

  withoutCode(body)
    .split('\n')
    .forEach((text, index) => {
      const line = index + 1;

      const definition = REFERENCE_DEFINITION.exec(text)?.[1];
      if (definition !== undefined) {
        links.push({ target: definition, line });
      }

      for (const match of text.matchAll(INLINE_LINK)) {
        const target = match[1];
        if (target !== undefined && target !== '') {
          links.push({ target, line });
        }
      }
    });

  return links;
}

/**
 * Turns heading text into the anchor Docusaurus will publish for it.
 *
 * Matches `github-slugger`, which is what Docusaurus uses: lowercase, drop everything that is not
 * a letter, a digit, a space, a hyphen or an underscore, then hyphenate the spaces. Inline
 * formatting is unwrapped first so `## The **CMS** GitHub App` and `## The CMS GitHub App` produce
 * the same anchor, as they do on the rendered page.
 */
function slugify(heading: string): string {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-');
}

/**
 * The anchors a page publishes, one per ATX heading.
 *
 * Repeated headings get the `-1`, `-2` suffixes Docusaurus appends, so a page with two
 * "Troubleshooting" sections resolves `#troubleshooting-1` as the reader's browser would.
 *
 * @param body - The whole file.
 * @returns Every anchor on the page.
 */
export function headingSlugs(body: string): ReadonlySet<string> {
  const slugs = new Set<string>();
  const seen = new Map<string, number>();

  for (const line of withoutCode(body).split('\n')) {
    const heading = ATX_HEADING.exec(line)?.[2];
    if (heading === undefined) {
      continue;
    }

    const base = slugify(heading);
    if (base === '') {
      continue;
    }

    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    slugs.add(count === 0 ? base : `${base}-${String(count)}`);
  }

  return slugs;
}

function isMarkdown(path: string): boolean {
  return MARKDOWN_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension));
}

/**
 * Which links this checker has an opinion about.
 *
 * Absolute site paths and external URLs are skipped rather than failed. An offline check cannot
 * reach `https://`, and a site-absolute `/adr/0001` depends on routing configuration this function
 * does not model — Docusaurus's `onBrokenLinks: 'throw'` still catches that one at build time.
 */
function isCheckable(target: string): boolean {
  return !URL_SCHEME.test(target) && !target.startsWith('//') && !target.startsWith('/');
}

/**
 * Checks every internal markdown link and anchor in the corpus (requirements.md R13).
 *
 * Runs over the whole corpus at once because a link is a claim about another page: resolving it
 * needs the set of files that exist and the anchors each one publishes.
 *
 * @param pages - Every corpus page, with its body.
 * @returns One problem per broken link, grouped by the page the link is on.
 *
 * @example
 * ```ts
 * checkLinks([{ file: 'docs/a.md', body: '[x](./b.md)' }]);
 * // → [{ rule: 'link-target', message: '"./b.md" does not resolve to a page ...', ... }]
 * ```
 */
export function checkLinks(pages: readonly CorpusPage[]): readonly Problem[] {
  const anchors = new Map(pages.map((page) => [page.file, headingSlugs(page.body)]));
  const problems: Problem[] = [];

  for (const page of pages) {
    const directory = posix.dirname(page.file);

    for (const link of findLinks(page.body)) {
      if (!isCheckable(link.target)) {
        continue;
      }

      const hash = link.target.indexOf('#');
      const path = hash === -1 ? link.target : link.target.slice(0, hash);
      const fragment = hash === -1 ? '' : link.target.slice(hash + 1);

      // An empty path means the fragment is on this page: `[see below](#what-is-recorded)`.
      const resolved = path === '' ? page.file : posix.normalize(posix.join(directory, path));

      if (path !== '' && !isMarkdown(resolved)) {
        continue;
      }

      const targetAnchors = anchors.get(resolved);
      if (targetAnchors === undefined) {
        problems.push({
          file: page.file,
          line: link.line,
          rule: 'link-target',
          message:
            `"${link.target}" does not resolve to a page in the corpus. ` +
            `Expected to find ${resolved}.`,
        });
        continue;
      }

      if (fragment !== '' && !targetAnchors.has(fragment)) {
        problems.push({
          file: page.file,
          line: link.line,
          rule: 'link-anchor',
          message:
            `"${link.target}" points at a "#${fragment}" section that ${resolved} does not have. ` +
            'Anchors come from the headings on that page.',
        });
      }
    }
  }

  return problems;
}
