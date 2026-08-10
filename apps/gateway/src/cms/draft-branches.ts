import { encodeRefPath } from '../git/branch-policy';
import { type GitHubClient } from '../git/github-client';
import { normalisePrefix } from '../kb/key-policy';

const HEADS_PREFIX = 'refs/heads/';

interface MatchingRefResponse {
  readonly ref?: string;
}

/**
 * Narrows an upstream body to a ref list.
 *
 * `matching-refs` answers with an array, but it is the one call here whose response shape changes
 * with the request — asking for a ref that exists exactly returns the object, not a list of one —
 * so the shape is checked rather than assumed. One assertion, in one place.
 */
function asRefList(body: unknown): readonly MatchingRefResponse[] {
  return Array.isArray(body) ? (body as readonly MatchingRefResponse[]) : [];
}

/**
 * Lists the draft branches the CMS owns.
 *
 * The editorial board has to show a draft that has not been submitted yet, and such a draft is
 * only a branch — there is no pull request to ask about. So this is the one place the gateway
 * enumerates rather than reading a ref it was told the name of.
 *
 * The prefix is re-applied to the results even though the git host already matched on it. That is
 * not redundant: `matching-refs` is a string prefix match, so the guarantee it gives depends on
 * the trailing slash being present, and this function is the only thing that knows it put one
 * there.
 *
 * @param client - The allowlisted git client.
 * @param branchPrefix - Prefix the CMS owns, e.g. `cms/`.
 * @returns Branch names under the prefix, without the `refs/heads/` qualifier.
 *
 * @example
 * ```ts
 * await listDraftBranches(client, 'cms/'); // → ['cms/guides/leave-policy']
 * ```
 */
export async function listDraftBranches(
  client: GitHubClient,
  branchPrefix: string,
): Promise<readonly string[]> {
  const prefix = normalisePrefix(branchPrefix);
  if (prefix === '') {
    // An empty prefix would ask the git host to list every branch in the repository, which the
    // endpoint allowlist refuses anyway. Answering "no drafts" keeps the failure quiet and closed
    // rather than surfacing a policy error for a configuration the branch policy already rejects.
    return [];
  }

  const response = await client.request<unknown>(
    'GET',
    client.path(`/git/matching-refs/heads/${encodeRefPath(prefix)}`),
  );

  return asRefList(response.body)
    .map((ref) => ref.ref ?? '')
    .filter((ref) => ref.startsWith(HEADS_PREFIX))
    .map((ref) => ref.slice(HEADS_PREFIX.length))
    .filter((branch) => branch.startsWith(prefix));
}
