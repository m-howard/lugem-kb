import { DocumentMissingError } from './documents';
import { CmsPolicyError } from './errors';
import { type CmsSettings } from './settings';
import { readBranchSnapshot, readTreeEntries } from './tree';
import { resolveBranch } from '../git/branch-policy';
import { type GitHubClient } from '../git/github-client';
import { mediaFileName, resolveMediaPath } from '../git/media-policy';

/** How many blobs a media listing reads at once. Same reasoning as `documents.ts`: the host rate-limits. */
const BLOB_READ_CONCURRENCY = 8;

export interface MediaSummary {
  readonly path: string;
  readonly sha: string;
  readonly size: number | undefined;
}

export interface MediaFile extends MediaSummary {
  readonly branch: string;
  /** The file's bytes, base64 encoded — which is how both the git host and the editor want them. */
  readonly content: string;
  /** Last path segment, which is the name an author gave the file. */
  readonly name: string;
}

interface BlobResponse {
  readonly content?: string;
  readonly encoding?: string;
}

export interface MediaServiceOptions {
  readonly client: GitHubClient;
  readonly settings: CmsSettings;
}

/**
 * Reads the images an author has uploaded (requirements.md R15).
 *
 * A sibling of {@link import('./documents').DocumentReader} rather than a method on it, because the
 * two answer to different policies and that difference is load-bearing: pages are confined by the
 * write prefixes and to markdown, images by the single media folder and to the formats
 * `git/media-policy.ts` permits. Folding them together would mean one predicate deciding both, and
 * the first refactor that widened it would widen both at once.
 *
 * Writing is not here. An upload is committed by `DraftService` in the same commit as the page that
 * shows it, so there is nothing for this service to write — see ADR 0021.
 */
export class MediaService {
  readonly #client: GitHubClient;
  readonly #settings: CmsSettings;

  constructor(options: MediaServiceOptions) {
    this.#client = options.client;
    this.#settings = options.settings;
  }

  /**
   * Lists the images on a branch, without their content.
   *
   * Kept separate from {@link listWithContent} because the editorial board only needs paths and shas
   * to work out what a draft changed, and reading every image to answer that would cost a blob per
   * screenshot on every board refresh.
   *
   * @param branch - Branch to read. Defaults to the repository's default branch.
   * @returns Every permitted image under the media folder.
   * @throws {CmsPolicyError} When the branch may not be read.
   */
  async list(branch = this.#settings.defaultBranch): Promise<readonly MediaSummary[]> {
    const snapshot = await readBranchSnapshot(this.#client, this.#resolveBranch(branch));
    if (snapshot === undefined) {
      return [];
    }

    const entries = await readTreeEntries(this.#client, snapshot.treeSha);
    return entries
      .filter((entry) => resolveMediaPath(entry.path, { folder: this.#settings.mediaFolder }).ok)
      .map((entry) => ({ path: entry.path, sha: entry.sha, size: entry.size }));
  }

  /**
   * Lists the images on a branch with their content, for the editor's media library.
   *
   * Decap's media library builds a blob URL per file from the content it is given, so it cannot be
   * answered with paths alone — showing the library costs one blob read per image. Reads are chunked
   * rather than fanned out at once, exactly as a collection listing is; a media folder an order of
   * magnitude larger would want paging, which Decap's protocol has no field for.
   *
   * @param branch - Branch to read. Defaults to the repository's default branch.
   * @returns Every permitted image under the media folder, in tree order.
   * @throws {CmsPolicyError} When the branch may not be read.
   */
  async listWithContent(branch = this.#settings.defaultBranch): Promise<readonly MediaFile[]> {
    const resolvedBranch = this.#resolveBranch(branch);
    const summaries = await this.list(resolvedBranch);
    const files: MediaFile[] = [];

    for (let index = 0; index < summaries.length; index += BLOB_READ_CONCURRENCY) {
      const chunk = summaries.slice(index, index + BLOB_READ_CONCURRENCY);
      files.push(
        ...(await Promise.all(
          chunk.map(async (summary) => ({
            ...summary,
            branch: resolvedBranch,
            name: mediaFileName(summary.path),
            content: await this.#readBlob(summary.sha),
          })),
        )),
      );
    }

    return files;
  }

  /**
   * Reads one image.
   *
   * @param path - Repository-relative path, inside the media folder.
   * @param branch - Branch to read. Defaults to the repository's default branch.
   * @returns The image, base64 encoded, with the blob sha the editor uses as its id.
   * @throws {CmsPolicyError} When the path is not a permitted image in the media folder, or the
   * branch may not be read.
   * @throws {DocumentMissingError} When the path is permitted but absent.
   */
  async read(path: string, branch = this.#settings.defaultBranch): Promise<MediaFile> {
    const resolved = resolveMediaPath(path, { folder: this.#settings.mediaFolder });
    if (!resolved.ok) {
      throw new CmsPolicyError(resolved.reason, resolved.message);
    }

    const resolvedBranch = this.#resolveBranch(branch);
    const snapshot = await readBranchSnapshot(this.#client, resolvedBranch);
    if (snapshot === undefined) {
      throw new DocumentMissingError(path, resolvedBranch);
    }

    const entries = await readTreeEntries(this.#client, snapshot.treeSha);
    const entry = entries.find((candidate) => candidate.path === resolved.path);
    if (entry === undefined) {
      throw new DocumentMissingError(path, resolvedBranch);
    }

    return {
      branch: resolvedBranch,
      path: resolved.path,
      name: mediaFileName(resolved.path),
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

  /**
   * Reads a blob as base64.
   *
   * Unlike the markdown reader's equivalent, the payload is passed through rather than decoded: the
   * git host already answers in base64, and that is the encoding the editor wants back. A round trip
   * through a UTF-8 string would not merely waste work — it would corrupt the bytes.
   */
  async #readBlob(sha: string): Promise<string> {
    const blob = await this.#client.request<BlobResponse>(
      'GET',
      this.#client.path(`/git/blobs/${sha}`),
    );
    const { content = '', encoding } = blob.body;

    return encoding === 'base64'
      ? content.replace(/\s+/g, '')
      : Buffer.from(content, 'utf8').toString('base64');
  }
}
