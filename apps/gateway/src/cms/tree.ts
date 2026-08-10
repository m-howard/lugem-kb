import { encodeRefPath } from '../git/branch-policy';
import { type GitHubClient } from '../git/github-client';

/** Where a branch points, and the tree it points at. */
export interface BranchSnapshot {
  readonly commitSha: string;
  readonly treeSha: string;
  /** When the tip commit was made, as the git host reported it. Absent if it did not. */
  readonly updatedAt: string | undefined;
}

export interface TreeEntry {
  readonly path: string;
  readonly type: string;
  readonly sha: string;
  readonly size?: number;
}

interface RefResponse {
  readonly object?: { readonly sha?: string };
}

interface CommitResponse {
  readonly tree?: { readonly sha?: string };
  readonly committer?: { readonly date?: string };
  readonly author?: { readonly date?: string };
}

interface TreeResponse {
  readonly tree?: readonly TreeEntry[];
  readonly truncated?: boolean;
}

/**
 * Reads where a branch points, or `undefined` when it does not exist.
 *
 * Absence is an answer rather than an error: saving the first version of a draft is exactly the
 * case where the branch is not there yet, and making the caller catch a 404 to discover that would
 * put control flow in an exception handler.
 *
 * @param client - The allowlisted git client.
 * @param branch - Branch name, already checked by branch policy.
 * @returns The commit and tree the branch points at, or `undefined`.
 */
export async function readBranchSnapshot(
  client: GitHubClient,
  branch: string,
): Promise<BranchSnapshot | undefined> {
  const ref = await client.getOrUndefined<RefResponse>(
    client.path(`/git/ref/heads/${encodeRefPath(branch)}`),
  );
  const commitSha = ref?.object?.sha;
  if (commitSha === undefined) {
    return undefined;
  }

  const commit = await client.getOrUndefined<CommitResponse>(
    client.path(`/git/commits/${commitSha}`),
  );
  const treeSha = commit?.tree?.sha;
  if (treeSha === undefined) {
    return undefined;
  }

  // The committer's date, not the author's: the committer is the App, so this is when the change
  // actually landed on the branch. The author's date travels with a rebased commit and would make
  // a draft look older than the work on it.
  return { commitSha, treeSha, updatedAt: commit?.committer?.date ?? commit?.author?.date };
}

/**
 * Reads every blob in a tree, recursively.
 *
 * A truncated response is treated as a failure rather than silently returning a partial corpus:
 * git's tree API truncates above roughly 100,000 entries, and a document list quietly missing its
 * tail is worse than an error, because nobody would notice.
 *
 * @param client - The allowlisted git client.
 * @param treeSha - Root tree to walk.
 * @returns Every blob entry in the tree.
 * @throws {Error} When the git host truncated the response.
 */
export async function readTreeEntries(
  client: GitHubClient,
  treeSha: string,
): Promise<readonly TreeEntry[]> {
  const response = await client.request<TreeResponse>(
    'GET',
    client.path(`/git/trees/${treeSha}?recursive=1`),
  );

  if (response.body.truncated === true) {
    throw new Error(
      'The git host truncated the repository tree. The corpus has outgrown a single listing.',
    );
  }

  return (response.body.tree ?? []).filter((entry) => entry.type === 'blob');
}
