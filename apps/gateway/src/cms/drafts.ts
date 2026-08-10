import { CmsPolicyError } from './errors';
import { type CmsSettings } from './settings';
import { type BranchSnapshot, readBranchSnapshot } from './tree';
import { type Identity } from '../auth/claims';
import { buildCommitPayload } from '../git/attribution';
import { type BranchOperation, encodeRefPath, resolveBranch } from '../git/branch-policy';
import { type GitHubClient } from '../git/github-client';
import { resolveDraftPaths } from '../git/path-policy';

/** Regular, non-executable file. The CMS writes prose; nothing it saves is a program. */
const BLOB_MODE = '100644';

export interface DraftFile {
  readonly path: string;
  readonly content: string;
  /**
   * How `content` is encoded. Defaults to `utf8` — a page is text.
   *
   * `base64` is how an image arrives (requirements.md R15): the editor sends it that way and the git
   * host accepts blobs that way, so the bytes are never decoded in between. Re-encoding a 2 MB
   * screenshot through a UTF-8 string would corrupt it, not just cost time.
   */
  readonly encoding?: 'utf8' | 'base64';
}

export interface SaveDraftRequest {
  readonly branch: string;
  readonly files: readonly DraftFile[];
  readonly deletions?: readonly string[];
  /** The author's own commit message. Attribution is added regardless of what they write. */
  readonly message?: string | undefined;
}

export interface SavedDraft {
  readonly branch: string;
  readonly commitSha: string;
  /** `true` when this save created the branch, `false` when it moved an existing one. */
  readonly created: boolean;
}

interface ShaResponse {
  readonly sha?: string;
}

interface TreeEntryPayload {
  readonly path: string;
  readonly mode: string;
  readonly type: 'blob';
  readonly sha: string | null;
}

export interface DraftServiceOptions {
  readonly client: GitHubClient;
  readonly settings: CmsSettings;
}

/**
 * Saving and discarding drafts (requirements.md R7's first half, under R3, R4 and R6).
 *
 * Saving creates or moves a branch and **never opens a pull request** — that is a separate,
 * deliberate act by the author, because a draft half-written over three days should not be sitting
 * in a reviewer's queue the whole time.
 *
 * Every path and the branch are checked before the first upstream call. That ordering is the
 * requirement, not an optimisation: a change set validated file by file as it was written would
 * apply its good half and fail on the rest, leaving the repository in a state nobody asked for and
 * no one reviewed.
 *
 * A commit may carry pages and images alike (requirements.md R15). That is one commit rather than
 * two on purpose: an image belongs to the page that shows it, and splitting them would let a
 * reviewer see a page referring to a file that is not there yet. See ADR 0021.
 */
export class DraftService {
  readonly #client: GitHubClient;
  readonly #settings: CmsSettings;

  constructor(options: DraftServiceOptions) {
    this.#client = options.client;
    this.#settings = options.settings;
  }

  /**
   * Saves a draft, creating the branch if it does not exist yet.
   *
   * @param request - Branch, files to write, paths to delete, and an optional message.
   * @param identity - The verified author, who becomes the commit author.
   * @returns The branch, the new commit, and whether the branch was created.
   * @throws {CmsPolicyError} When any path or the branch is refused. Nothing is written.
   */
  async save(request: SaveDraftRequest, identity: Identity): Promise<SavedDraft> {
    const deletions = request.deletions ?? [];
    const branch = this.#resolveBranch(request.branch, 'update');
    const paths = resolveDraftPaths([...request.files.map((file) => file.path), ...deletions], {
      prefixes: this.#settings.pathPrefixes,
      mediaFolder: this.#settings.mediaFolder,
    });
    if (!paths.ok) {
      throw new CmsPolicyError(paths.reason, paths.message);
    }
    if (request.files.length === 0 && deletions.length === 0) {
      throw new CmsPolicyError('empty-change-set', 'A draft must write or delete something.');
    }

    const existing = await readBranchSnapshot(this.#client, branch);
    const base = existing ?? (await this.#baseSnapshot());
    const commitSha = await this.#commit(request, { identity, base });

    await this.#moveBranch(branch, commitSha, existing === undefined);
    return { branch, commitSha, created: existing === undefined };
  }

  /**
   * Discards a draft by deleting its branch.
   *
   * @param branch - The draft branch.
   * @throws {CmsPolicyError} When the branch is outside the CMS prefix, or is the default branch.
   */
  async discard(branch: string): Promise<void> {
    const resolved = this.#resolveBranch(branch, 'delete');
    await this.#client.request(
      'DELETE',
      this.#client.path(`/git/refs/heads/${encodeRefPath(resolved)}`),
    );
  }

  #resolveBranch(branch: string, operation: BranchOperation): string {
    const resolved = resolveBranch(branch, {
      prefix: this.#settings.branchPrefix,
      defaultBranch: this.#settings.defaultBranch,
      operation,
    });
    if (!resolved.ok) {
      throw new CmsPolicyError(resolved.reason, resolved.message);
    }
    return resolved.branch;
  }

  async #baseSnapshot(): Promise<BranchSnapshot> {
    const base = await readBranchSnapshot(this.#client, this.#settings.defaultBranch);
    if (base === undefined) {
      throw new Error(
        `The default branch ${this.#settings.defaultBranch} has no commits to branch from.`,
      );
    }
    return base;
  }

  async #commit(
    request: SaveDraftRequest,
    context: { readonly identity: Identity; readonly base: BranchSnapshot },
  ): Promise<string> {
    const entries: TreeEntryPayload[] = [
      ...(await Promise.all(request.files.map((file) => this.#blobEntry(file)))),
      ...(request.deletions ?? []).map((path) => ({
        path,
        mode: BLOB_MODE,
        type: 'blob' as const,
        sha: null,
      })),
    ];

    const tree = await this.#client.request<ShaResponse>('POST', this.#client.path('/git/trees'), {
      base_tree: context.base.treeSha,
      tree: entries,
    });
    const treeSha = requireSha(tree.body, 'tree');

    const commit = await this.#client.request<ShaResponse>(
      'POST',
      this.#client.path('/git/commits'),
      buildCommitPayload(
        {
          message: request.message?.trim() ?? defaultMessage(request),
          tree: treeSha,
          parents: [context.base.commitSha],
        },
        context.identity,
      ),
    );
    return requireSha(commit.body, 'commit');
  }

  async #blobEntry(file: DraftFile): Promise<TreeEntryPayload> {
    const content =
      file.encoding === 'base64'
        ? file.content
        : Buffer.from(file.content, 'utf8').toString('base64');
    const blob = await this.#client.request<ShaResponse>('POST', this.#client.path('/git/blobs'), {
      content,
      encoding: 'base64',
    });

    return { path: file.path, mode: BLOB_MODE, type: 'blob', sha: requireSha(blob.body, 'blob') };
  }

  async #moveBranch(branch: string, sha: string, create: boolean): Promise<void> {
    if (create) {
      await this.#client.request('POST', this.#client.path('/git/refs'), {
        ref: `refs/heads/${branch}`,
        sha,
      });
      return;
    }

    await this.#client.request(
      'PATCH',
      this.#client.path(`/git/refs/heads/${encodeRefPath(branch)}`),
      {
        sha,
        force: false,
      },
    );
  }
}

function requireSha(body: ShaResponse, what: string): string {
  if (typeof body.sha !== 'string' || body.sha === '') {
    throw new Error(`The git host returned a ${what} with no sha.`);
  }
  return body.sha;
}

function defaultMessage(request: SaveDraftRequest): string {
  const touched = [...request.files.map((file) => file.path), ...(request.deletions ?? [])];
  const subject = touched.length === 1 ? touched[0] : `${String(touched.length)} pages`;

  return `docs: update ${String(subject)}`;
}
