import { posix } from 'node:path';

import GithubSlugger from 'github-slugger';

import { type Problem } from './problem';

/** `](target)` or `](target "title")`. The target stops at whitespace or the closing bracket. */
const INLINE_LINK = /\]\(\s*([^)\s]*)\s*(?:"[^"]*"|'[^']*')?\s*\)/g;

/** A reference definition: `[label]: target`, at the start of a line. */
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:[ \t]*(\S+)/;

/** An opening or closing code fence, indented up to three spaces as CommonMark allows. */
const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})/;

const ATX_HEADING = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;

/**
 * Docusaurus's classic explicit heading id: `## Runbook {#ops}`.
 *
 * The same expression `parseMarkdownHeadingId` in `@docusaurus/utils` uses — anchored to the end of
 * the heading, and refusing an id that itself contains `{#` or `}`.
 */
const CLASSIC_HEADING_ID = /\s*\{#(?<id>(?:.(?!\{#|\}))*.)\}$/;

/**
 * The comment form of the same thing: a heading closed by an MDX comment holding `#ops`.
 *
 * The MDX spelling only. Docusaurus also reads an id out of an HTML comment, but that path needs
 * the heading parsed as CommonMark, and this site leaves `markdown.format` at its default — every
 * page here is MDX, where `<!-- -->` never becomes a comment node. Checked against a real build
 * rather than assumed; `links.test.ts` spells the form out.
 */
const COMMENT_HEADING_ID = /\s*\{\/\*(?<comment>[\s\S]*?)\*\/\}$/;

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
 * Reduces a heading to the plain text a renderer would show.
 *
 * Docusaurus slugs the heading's rendered text, not its markdown source, so `## The **CMS** App`
 * and `## The CMS App` publish the same anchor. Unwrapping links and emphasis here is what makes
 * the two agree. Everything after this is `github-slugger`'s business, not ours.
 *
 * `_` is left in place, unlike the other emphasis characters. It survives into the rendered text
 * far more often than it opens emphasis — `## The snake_case option` publishes
 * `#the-snake_case-option` — and this corpus writes strong text as `**`, which markdownlint's
 * MD050 enforces.
 */
function headingText(heading: string): string {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`~]/g, '')
    .trim();
}

/**
 * The id an author wrote on the heading, if they wrote one.
 *
 * Two spellings, in Docusaurus's own order of preference: a trailing MDX comment holding `#id`,
 * then the classic `{#id}`. A comment without the `#` is a comment — Docusaurus wants the marker
 * so that a note to a future editor does not silently become an anchor.
 */
function explicitHeadingId(heading: string): string | undefined {
  const comment = COMMENT_HEADING_ID.exec(heading)?.groups?.['comment'];

  if (comment !== undefined) {
    const marked = comment.trim().split(' ')[0] ?? '';
    if (marked.startsWith('#') && marked.length > 1) {
      return marked.slice(1);
    }
  }

  return CLASSIC_HEADING_ID.exec(heading)?.groups?.['id']?.trim();
}

/**
 * The anchors a page publishes, one per ATX heading.
 *
 * Two rules here are Docusaurus's rather than obvious, and getting either wrong fails an author
 * for a link that works:
 *
 * 1. **An explicit id wins and is used verbatim.** `## Runbook {#ops}` publishes `#ops`, not
 *    `#runbook-ops`. Docusaurus does not pass it through the slugger either, so it takes no place
 *    in the `-1`, `-2` sequence a repeated heading produces. The comment spellings count too.
 * 2. **Uniqueness is global, not per heading.** `github-slugger` remembers every slug it has
 *    already returned, so `Foo`, `Foo`, `Foo-1` publishes `foo`, `foo-1`, `foo-1-1` — the third
 *    heading collides with the second's *output*. Counting occurrences per base text instead
 *    yields only two anchors and rejects `#foo-1-1`.
 *
 * The slugger is the one Docusaurus itself uses, at the version it resolves, and one instance per
 * page because that is the scope Docusaurus gives it.
 *
 * @param body - The whole file.
 * @returns Every anchor on the page.
 *
 * @example
 * ```ts
 * headingSlugs('## Runbook {#ops}\n## Runbook\n');
 * // → Set { 'ops', 'runbook' }
 * ```
 */
export function headingSlugs(body: string): ReadonlySet<string> {
  const slugs = new Set<string>();
  const slugger = new GithubSlugger();

  for (const line of withoutCode(body).split('\n')) {
    const heading = ATX_HEADING.exec(line)?.[2];
    if (heading === undefined) {
      continue;
    }

    // Read off the raw heading, before formatting is unwrapped: an id is used verbatim, and that
    // step is free to touch characters an id may legitimately contain.
    const explicitId = explicitHeadingId(heading);
    if (explicitId !== undefined) {
      slugs.add(explicitId);
      continue;
    }

    const text = headingText(heading);
    if (text === '') {
      continue;
    }

    slugs.add(slugger.slug(text));
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
