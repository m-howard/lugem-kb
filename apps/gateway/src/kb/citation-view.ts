import { type CorpusClient } from './corpus-client';
import { readFrontmatterField } from './frontmatter';
import { type Citation } from './retrieve';
import { type CorpusLocation, resolveSourceUrl } from './source-url';

/** Frontmatter sits at the top of the file; a ranged read avoids pulling a 40 KB page for one line. */
const FRONTMATTER_BYTES = 2048;

/** Review dates change on merge, not on request. Ten minutes keeps the corpus fresh enough. */
const DEFAULT_CACHE_TTL_MS = 600_000;

const REVIEW_DATE_FIELD = 'last_reviewed';

export interface CitationView {
  /** Source object URI, verbatim from retrieval. Kept so an operator can trace a citation to S3. */
  readonly sourceUri: string;
  /** Path relative to the corpus prefix, or `null` when the URI is not part of this corpus. */
  readonly path: string | null;
  /** Route on the published site, or `null` when the source has no page a reader can open. */
  readonly url: string | null;
  /** The retrieved passage, verbatim. Never paraphrased — this is what makes the citation checkable. */
  readonly text: string;
  readonly score: number;
  /** The page's `last_reviewed` frontmatter, or `null` when it could not be read. */
  readonly lastReviewed: string | null;
}

export interface CitationViewerOptions {
  readonly corpus: CorpusClient;
  readonly location: CorpusLocation;
  readonly cacheTtlMs?: number;
}

interface CachedDate {
  readonly value: string | undefined;
  readonly expiresAt: number;
}

/**
 * Turns retrieval citations into what an API client can render.
 *
 * Two things happen here. The `s3://` URI becomes the page a reader can open, and the page's
 * `last_reviewed` date is attached — R20 requires staleness to be as visible in an answer as it
 * is on the page itself, and a link alone does not show it.
 *
 * Reading the date costs one ranged S3 GET per distinct source, at most five per question, run in
 * parallel and cached. **It fails open**: a source whose date cannot be read yields `null` and the
 * answer proceeds. Blocking an answer because a metadata lookup failed would trade a whole feature
 * for a subtitle.
 */
export class CitationViewer {
  readonly #corpus: CorpusClient;
  readonly #location: CorpusLocation;
  readonly #cacheTtlMs: number;
  readonly #cache = new Map<string, CachedDate>();

  constructor(options: CitationViewerOptions) {
    this.#corpus = options.corpus;
    this.#location = options.location;
    this.#cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  /**
   * Resolves every citation to its page and review date.
   *
   * @param citations - Citations as returned by the retriever, in relevance order.
   * @returns The same citations, in the same order, with their page location resolved.
   */
  async present(citations: readonly Citation[]): Promise<CitationView[]> {
    const resolved = citations.map((citation) => ({
      citation,
      source: resolveSourceUrl(citation.sourceUri, this.#location),
    }));

    const paths = [...new Set(resolved.flatMap((item) => (item.source ? [item.source.path] : [])))];
    const dates = await this.#reviewDates(paths);

    return resolved.map((item) => ({
      sourceUri: item.citation.sourceUri,
      path: item.source?.path ?? null,
      url: item.source?.url ?? null,
      text: item.citation.text,
      score: item.citation.score,
      lastReviewed: (item.source === undefined ? undefined : dates.get(item.source.path)) ?? null,
    }));
  }

  async #reviewDates(paths: readonly string[]): Promise<Map<string, string>> {
    const now = Date.now();
    const found = new Map<string, string>();
    const misses: string[] = [];

    for (const path of paths) {
      const cached = this.#cache.get(path);
      if (cached === undefined || cached.expiresAt <= now) {
        misses.push(path);
        continue;
      }
      if (cached.value !== undefined) {
        found.set(path, cached.value);
      }
    }

    const fetched = await Promise.all(misses.map(async (path) => this.#fetchReviewDate(path)));
    for (const [index, value] of fetched.entries()) {
      const path = misses[index] ?? '';
      this.#cache.set(path, { value, expiresAt: now + this.#cacheTtlMs });
      if (value !== undefined) {
        found.set(path, value);
      }
    }

    return found;
  }

  /** Fails open: an unreadable page yields no date rather than an error, and is cached as such. */
  async #fetchReviewDate(path: string): Promise<string | undefined> {
    try {
      const document = await this.#corpus.get(path, { maxBytes: FRONTMATTER_BYTES });
      return readFrontmatterField(document.body, REVIEW_DATE_FIELD);
    } catch {
      return undefined;
    }
  }
}
