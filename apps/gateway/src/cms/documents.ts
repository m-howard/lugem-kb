import { CmsPolicyError } from './errors';
import { type CmsSettings } from './settings';
import { readBranchSnapshot, readTreeEntries } from './tree';
import { resolveBranch } from '../git/branch-policy';
import { type GitHubClient } from '../git/github-client';
import { resolveWritePath } from '../git/path-policy';

/** How many blobs a collection listing reads at once. The git host rate-limits; this is polite. */
const BLOB_READ_CONCURRENCY = 8;

export interface DocumentSummary {
  readonly path: string;
  readonly sha: string;
  readonly size: number | undefined;
}

export interface DocumentContent extends DocumentSummary {
  readonly branch: string;
  readonly content: string;
}

interface BlobResponse {
  readonly content?: string;
  readonly encoding?: string;
}

export interface DocumentReaderOptions {
  readonly client: GitHubClient;
  readonly settings: CmsSettings;
}

/** Thrown when a permitted path simply is not in the tree. Distinct from a refusal — R9. */
export class DocumentMissingError extends Error {
  constructor(path: string, branch: string) {
    super(`No document at ${path} on ${branch}.`);
    this.name = 'DocumentMissingError';
  }
}

/**
 * Reads the corpus as the CMS sees it: through git, on a named branch.
 *
 * This is deliberately not the S3 `CorpusClient`. That one reads what has been *published*, which
 * is the right source for answering a reader's question and the wrong one for editing — an author
 * opening a page must see their own unmerged draft, not last night's ingested copy.
 *
 * The same path policy applies to reads as to writes. R3 governs writes, so confining reads is
 * stricter than asked; it costs nothing, because the CMS never legitimately reads outside the
 * documentation prefixes, and it means one answer to "can this path be touched" rather than two.
 */
export class DocumentReader {
  readonly #client: GitHubClient;
  readonly #settings: CmsSettings;

  constructor(options: DocumentReaderOptions) {
    this.#client = options.client;
    this.#settings = options.settings;
  }

  /**
   * Lists the documents on a branch.
   *
   * @param branch - Branch to read. Defaults to the repository's default branch.
   * @returns Every document under a configured prefix, with a permitted extension.
   * @throws {CmsPolicyError} When the branch may not be read.
   */
  async list(branch = this.#settings.defaultBranch): Promise<readonly DocumentSummary[]> {
    const snapshot = await readBranchSnapshot(this.#client, this.#resolveBranch(branch));
    if (snapshot === undefined) {
      return [];
    }

    const entries = await readTreeEntries(this.#client, snapshot.treeSha);
    return entries
      .filter((entry) => resolveWritePath(entry.path, { prefixes: this.#settings.pathPrefixes }).ok)
      .map((entry) => ({ path: entry.path, sha: entry.sha, size: entry.size }));
  }

  /**
   * Reads the documents on a branch that `select` accepts, with their content.
   *
   * Exists because listing a collection needs content, and doing that as N calls to {@link read}
   * would re-read the branch ref and the whole tree once per document — four upstream calls per
   * page instead of three for the branch plus one per page. The predicate is applied *before* the
   * blobs are fetched, so a narrow collection costs only what it selects.
   *
   * @param select - Decides which repository-relative paths to read.
   * @param branch - Branch to read. Defaults to the repository's default branch.
   * @returns The selected documents, in tree order.
   * @throws {CmsPolicyError} When the branch may not be read.
   */
  async listContent(
    select: (path: string) => boolean,
    branch = this.#settings.defaultBranch,
  ): Promise<readonly DocumentContent[]> {
    const resolvedBranch = this.#resolveBranch(branch);
    const snapshot = await readBranchSnapshot(this.#client, resolvedBranch);
    if (snapshot === undefined) {
      return [];
    }

    const entries = (await readTreeEntries(this.#client, snapshot.treeSha))
      .filter((entry) => resolveWritePath(entry.path, { prefixes: this.#settings.pathPrefixes }).ok)
      .filter((entry) => select(entry.path));

    const documents: DocumentContent[] = [];
    // Chunked rather than one `Promise.all` over the whole collection: the git host rate-limits,
    // and a collection listing is the one operation whose fan-out is set by how much content
    // exists rather than by what the author just typed.
    for (let index = 0; index < entries.length; index += BLOB_READ_CONCURRENCY) {
      const chunk = entries.slice(index, index + BLOB_READ_CONCURRENCY);
      documents.push(
        ...(await Promise.all(
          chunk.map(async (entry) => ({
            branch: resolvedBranch,
            path: entry.path,
            sha: entry.sha,
            size: entry.size,
            content: await this.#readBlob(entry.sha),
          })),
        )),
      );
    }

    return documents;
  }

  /**
   * Reads one document.
   *
   * @param path - Repository-relative path.
   * @param branch - Branch to read. Defaults to the repository's default branch.
   * @returns The document and the blob sha an editor needs to write it back safely.
   * @throws {CmsPolicyError} When the path or branch may not be read.
   * @throws {DocumentMissingError} When the path is permitted but absent.
   */
  async read(path: string, branch = this.#settings.defaultBranch): Promise<DocumentContent> {
    const resolvedPath = resolveWritePath(path, { prefixes: this.#settings.pathPrefixes });
    if (!resolvedPath.ok) {
      throw new CmsPolicyError(resolvedPath.reason, resolvedPath.message);
    }

    const resolvedBranch = this.#resolveBranch(branch);
    const snapshot = await readBranchSnapshot(this.#client, resolvedBranch);
    if (snapshot === undefined) {
      throw new DocumentMissingError(path, resolvedBranch);
    }

    const entries = await readTreeEntries(this.#client, snapshot.treeSha);
    const entry = entries.find((candidate) => candidate.path === resolvedPath.path);
    if (entry === undefined) {
      throw new DocumentMissingError(path, resolvedBranch);
    }

    return {
      branch: resolvedBranch,
      path: resolvedPath.path,
      sha: entry.sha,
      size: entry.size,
      content: await this.#readBlob(entry.sha),
    };
  }

  #resolveBranch(branch: string): string {
    const resolved = resolveBranch(branch, {
      prefix: this.#settings.branchPrefix,
      defaultBranch: this.#settings.defaultBranch,
      operation: 'read',
    });
    if (!resolved.ok) {
      throw new CmsPolicyError(resolved.reason, resolved.message);
    }
    return resolved.branch;
  }

  async #readBlob(sha: string): Promise<string> {
    const blob = await this.#client.request<BlobResponse>(
      'GET',
      this.#client.path(`/git/blobs/${sha}`),
    );
    const { content = '', encoding } = blob.body;

    return encoding === 'base64' ? Buffer.from(content, 'base64').toString('utf8') : content;
  }
}
