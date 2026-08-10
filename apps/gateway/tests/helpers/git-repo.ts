import { createHash } from 'node:crypto';

/**
 * A git repository, small enough to hold in memory and real enough to author against.
 *
 * The existing `fake-github.ts` answers a declared table of canned responses, which is right for a
 * test asserting *which* upstream calls a route makes. It cannot answer what a person doing local
 * development needs — "save this page, then show it to me again" — because the read is a different
 * fixture from the write. This models the objects instead, so a save is genuinely readable
 * afterwards and a draft branch genuinely exists.
 *
 * Only what the gateway's endpoint allowlist can reach is modelled (`src/git/endpoint-policy.ts`),
 * which is what keeps this small: blobs, flat trees, commits, branch refs, and pull requests. There
 * are no packfiles, no merge bases, no annotated tags, and trees are stored as flat path maps
 * because the one tree read the gateway makes is `?recursive=1`.
 *
 * The state is plain JSON so a local sandbox can write it to disk between runs. That is the whole
 * reason for {@link RepoState} being a separate shape from the class.
 */

/** Blob mode for a regular file. The CMS writes prose and images; nothing it saves is a program. */
export const BLOB_MODE = '100644';

const HEADS_PREFIX = 'refs/heads/';
const SHA_LENGTH = 40;

export interface CommitSignature {
  readonly name: string;
  readonly email: string;
  readonly date: string;
}

export interface CommitObject {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
  readonly author: CommitSignature;
  readonly committer: CommitSignature;
}

export interface PullState {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly head: string;
  readonly base: string;
  readonly createdAt: string;
  state: 'open' | 'closed';
  merged: boolean;
}

/** The whole repository, JSON-serialisable so a sandbox can persist it between runs. */
export interface RepoState {
  /** Blob sha to base64 content. Base64 throughout: that is how the gateway sends and reads it. */
  readonly blobs: Record<string, string>;
  /** Tree sha to a flat `path -> blob sha` map. */
  readonly trees: Record<string, Record<string, string>>;
  readonly commits: Record<string, CommitObject>;
  /** Branch name (no `refs/heads/`) to commit sha. */
  readonly refs: Record<string, string>;
  readonly pulls: PullState[];
}

export interface TreeEntryInput {
  readonly path: string;
  /** `null` deletes the path, which is how `DraftService` expresses a removal. */
  readonly sha: string | null;
}

export interface CreateCommitInput {
  readonly message: string;
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author?: CommitSignature | undefined;
  readonly committer?: CommitSignature | undefined;
}

export interface SeedFile {
  readonly content: string;
  readonly encoding?: 'utf8' | 'base64';
}

/** Raised for a condition the git host reports with a status, so the HTTP layer can map it. */
export class GitRepoError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitRepoError';
    this.status = status;
  }
}

const NOT_FOUND = 404;
const UNPROCESSABLE = 422;

function sha1(kind: string, payload: string): string {
  return createHash('sha1').update(`${kind}\0${payload}`).digest('hex').slice(0, SHA_LENGTH);
}

function base64Of(file: SeedFile): string {
  return file.encoding === 'base64'
    ? file.content
    : Buffer.from(file.content, 'utf8').toString('base64');
}

/** The App is the committer, matching what a real installation token produces — see attribution.ts. */
function appSignature(date: string): CommitSignature {
  return { name: 'Lugem CMS', email: 'cms@lugem.invalid', date };
}

function emptyState(): RepoState {
  return { blobs: {}, trees: {}, commits: {}, refs: {}, pulls: [] };
}

export class GitRepo {
  readonly #state: RepoState;
  readonly #now: () => Date;

  constructor(state: RepoState = emptyState(), now: () => Date = () => new Date()) {
    this.#state = state;
    this.#now = now;
  }

  /** The state as plain JSON, for a caller that wants to write it to disk. */
  snapshot(): RepoState {
    return structuredClone(this.#state);
  }

  // --- objects -------------------------------------------------------------------------------

  /**
   * Stores a blob.
   *
   * @param base64 - Content, already base64. The gateway always sends base64, and re-encoding a
   *   PNG through a UTF-8 string would corrupt it.
   * @returns The content-addressed sha.
   */
  createBlob(base64: string): string {
    const sha = sha1('blob', base64);
    this.#state.blobs[sha] = base64;
    return sha;
  }

  readBlob(sha: string): string {
    const content = this.#state.blobs[sha];
    if (content === undefined) {
      throw new GitRepoError(NOT_FOUND, 'Not Found');
    }
    return content;
  }

  /**
   * Builds a tree from a base tree plus a change set.
   *
   * @param baseTree - Tree to start from, or `undefined` for an empty one.
   * @param entries - Paths to write, or to delete when `sha` is `null`.
   * @returns The content-addressed sha of the resulting tree.
   */
  createTree(baseTree: string | undefined, entries: readonly TreeEntryInput[]): string {
    const files: Record<string, string> =
      baseTree === undefined ? {} : { ...this.readTree(baseTree) };

    for (const entry of entries) {
      if (entry.sha === null) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete files[entry.path];
      } else {
        files[entry.path] = entry.sha;
      }
    }

    const sha = sha1(
      'tree',
      Object.keys(files)
        .sort()
        .map((path) => `${path}\0${String(files[path])}`)
        .join('\n'),
    );
    this.#state.trees[sha] = files;
    return sha;
  }

  readTree(sha: string): Record<string, string> {
    const tree = this.#state.trees[sha];
    if (tree === undefined) {
      throw new GitRepoError(NOT_FOUND, 'Not Found');
    }
    return tree;
  }

  /** The byte length of a blob, which is what a tree listing reports as `size`. */
  blobSize(sha: string): number {
    return Buffer.from(this.readBlob(sha), 'base64').length;
  }

  createCommit(input: CreateCommitInput): string {
    const date = this.#now().toISOString();
    const committer = input.committer ?? appSignature(date);
    const author = input.author ?? committer;
    const sha = sha1(
      'commit',
      [input.tree, input.parents.join(','), input.message, author.email, committer.date].join('\0'),
    );

    this.#state.commits[sha] = {
      tree: input.tree,
      parents: [...input.parents],
      message: input.message,
      author,
      committer,
    };
    return sha;
  }

  readCommit(sha: string): CommitObject {
    const commit = this.#state.commits[sha];
    if (commit === undefined) {
      throw new GitRepoError(NOT_FOUND, 'Not Found');
    }
    return commit;
  }

  // --- refs ----------------------------------------------------------------------------------

  getRef(branch: string): string | undefined {
    return this.#state.refs[branch];
  }

  /** Branch names under a prefix, as `matching-refs` reports them. */
  matchingRefs(prefix: string): readonly string[] {
    return Object.keys(this.#state.refs)
      .filter((branch) => branch.startsWith(prefix))
      .sort();
  }

  createRef(branch: string, sha: string): void {
    if (this.#state.refs[branch] !== undefined) {
      throw new GitRepoError(UNPROCESSABLE, 'Reference already exists');
    }
    this.readCommit(sha);
    this.#state.refs[branch] = sha;
  }

  /**
   * Moves a branch, refusing a non-fast-forward unless forced.
   *
   * This refusal is the reason the model bothers to track parents. It is what produces the `409`
   * an author sees as "this draft moved since you opened it" (`routes/cms.ts`), and a fake that
   * always accepted the update would make that path unreachable both in tests and by hand.
   */
  updateRef(branch: string, sha: string, force: boolean): void {
    const current = this.#state.refs[branch];
    if (current === undefined) {
      throw new GitRepoError(UNPROCESSABLE, 'Reference does not exist');
    }
    this.readCommit(sha);
    if (!force && !this.#isDescendant(sha, current)) {
      throw new GitRepoError(UNPROCESSABLE, 'Update is not a fast forward');
    }
    this.#state.refs[branch] = sha;
  }

  deleteRef(branch: string): void {
    if (this.#state.refs[branch] === undefined) {
      throw new GitRepoError(UNPROCESSABLE, 'Reference does not exist');
    }
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete this.#state.refs[branch];
  }

  #isDescendant(candidate: string, ancestor: string): boolean {
    const seen = new Set<string>();
    const queue = [candidate];

    while (queue.length > 0) {
      const sha = queue.shift() ?? '';
      if (sha === ancestor) {
        return true;
      }
      if (seen.has(sha)) {
        continue;
      }
      seen.add(sha);
      queue.push(...(this.#state.commits[sha]?.parents ?? []));
    }
    return false;
  }

  // --- pull requests -------------------------------------------------------------------------

  createPull(input: { title: string; body: string; head: string; base: string }): PullState {
    const pull: PullState = {
      number:
        this.#state.pulls.reduce((highest, existing) => Math.max(highest, existing.number), 0) + 1,
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
      createdAt: this.#now().toISOString(),
      state: 'open',
      merged: false,
    };
    this.#state.pulls.push(pull);
    return pull;
  }

  readPull(number: number): PullState {
    const pull = this.#state.pulls.find((candidate) => candidate.number === number);
    if (pull === undefined) {
      throw new GitRepoError(NOT_FOUND, 'Not Found');
    }
    return pull;
  }

  /** Newest first, matching the `sort=created&direction=desc` the gateway always asks for. */
  listPulls(filter: {
    state?: string | undefined;
    head?: string | undefined;
  }): readonly PullState[] {
    return this.#state.pulls
      .filter(
        (pull) =>
          filter.state === undefined || filter.state === 'all' || pull.state === filter.state,
      )
      .filter((pull) => filter.head === undefined || pull.head === filter.head)
      .toSorted((left, right) => right.number - left.number);
  }

  closePull(number: number): PullState {
    const pull = this.readPull(number);
    pull.state = 'closed';
    return pull;
  }

  /**
   * Squash-merges a submission onto its base.
   *
   * Squash rather than a merge commit because that is the `merge_method` the gateway sends. The
   * result is a single commit on the base carrying the head's tree, which is what makes a merged
   * page show up in the default branch's document list afterwards.
   */
  mergePull(number: number): { pull: PullState; sha: string } {
    const pull = this.readPull(number);
    const head = this.getRef(pull.head);
    const base = this.getRef(pull.base);
    if (head === undefined || base === undefined) {
      throw new GitRepoError(UNPROCESSABLE, 'Pull request is not mergeable');
    }

    const sha = this.createCommit({
      message: `${pull.title} (#${String(pull.number)})`,
      tree: this.readCommit(head).tree,
      parents: [base],
    });
    this.updateRef(pull.base, sha, true);
    pull.state = 'closed';
    pull.merged = true;
    return { pull, sha };
  }

  // --- seeding -------------------------------------------------------------------------------

  /**
   * Creates the first commit on a branch from a set of files.
   *
   * @param branch - Branch to point at the new commit, e.g. `main`.
   * @param files - Repository-relative path to content.
   * @returns The commit sha.
   */
  seed(branch: string, files: Readonly<Record<string, SeedFile>>): string {
    const entries = Object.entries(files).map(([path, file]) => ({
      path,
      sha: this.createBlob(base64Of(file)),
    }));
    const tree = this.createTree(undefined, entries);
    const sha = this.createCommit({ message: 'docs: seed the sandbox corpus', tree, parents: [] });

    this.#state.refs[branch] = sha;
    return sha;
  }
}

/** Strips the `refs/heads/` qualifier a caller may or may not have included. */
export function branchOf(ref: string): string {
  return ref.startsWith(HEADS_PREFIX) ? ref.slice(HEADS_PREFIX.length) : ref;
}
