/** Repository-scoped path, captured as owner, name and the rest. */
const REPOSITORY_PATH = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/;

export type EndpointViolation = 'not-a-repository-path' | 'other-repository' | 'not-allowlisted';

export type EndpointDecision =
  | { readonly ok: true; readonly what: string }
  | { readonly ok: false; readonly reason: EndpointViolation; readonly message: string };

export interface EndpointPolicyOptions {
  /** `owner/name` of the corpus repository. The only repository the credential may act on. */
  readonly repository: string;
  /** requirements.md R7: by default the gateway refuses merge requests from the CMS. */
  readonly allowMergeFromCms: boolean;
}

interface EndpointRule {
  readonly method: string;
  readonly pattern: RegExp;
  /** What an operator would call this call, for the audit log and for reading the table. */
  readonly what: string;
  readonly requiresMergePolicy?: true;
}

/**
 * Every call the gateway may make at the git host (requirements.md R5).
 *
 * This table *is* the allowlist. Anything absent from it is refused before a socket is opened, so
 * widening what the CMS credential can reach means editing this file and having the edit
 * reviewed — which is the acceptance criterion, not a side effect of it.
 *
 * What is deliberately missing is as load-bearing as what is here: no branch protection, no
 * collaborators, no webhooks, no deploy keys, no workflow dispatch, no repository settings. The
 * App is also created without those permissions (docs/corpus-repository.md), so this is the second
 * of two independent refusals rather than the only one.
 *
 * The installation-token mint is not in this table. It is not part of the editorial workflow, it
 * is not repository-scoped, and `installation-token.ts` reaches exactly one hard-coded URL.
 */
const ALLOWLIST: readonly EndpointRule[] = [
  { method: 'GET', pattern: /^\/git\/ref\/heads\/.+$/, what: 'read a branch ref' },
  { method: 'GET', pattern: /^\/git\/trees\/[^/]+$/, what: 'read a tree' },
  { method: 'GET', pattern: /^\/git\/blobs\/[^/]+$/, what: 'read a blob' },
  { method: 'GET', pattern: /^\/git\/commits\/[^/]+$/, what: 'read a commit' },
  { method: 'POST', pattern: /^\/git\/blobs$/, what: 'create a blob' },
  { method: 'POST', pattern: /^\/git\/trees$/, what: 'create a tree' },
  { method: 'POST', pattern: /^\/git\/commits$/, what: 'create a commit' },
  { method: 'POST', pattern: /^\/git\/refs$/, what: 'create a branch' },
  { method: 'PATCH', pattern: /^\/git\/refs\/heads\/.+$/, what: 'move a branch' },
  { method: 'DELETE', pattern: /^\/git\/refs\/heads\/.+$/, what: 'delete a branch' },
  { method: 'GET', pattern: /^\/pulls$/, what: 'list pull requests' },
  { method: 'GET', pattern: /^\/pulls\/\d+$/, what: 'read a pull request' },
  { method: 'POST', pattern: /^\/pulls$/, what: 'open a pull request' },
  { method: 'PATCH', pattern: /^\/pulls\/\d+$/, what: 'update a pull request' },
  {
    method: 'PUT',
    pattern: /^\/pulls\/\d+\/merge$/,
    what: 'merge a pull request',
    requiresMergePolicy: true,
  },
];

/** Names in the table, so a refusal message can show a caller what it could have asked for. */
export const ALLOWLISTED_CALLS: readonly string[] = ALLOWLIST.map((rule) => rule.what);

function refuse(reason: EndpointViolation, message: string): EndpointDecision {
  return { ok: false, reason, message };
}

/**
 * Decides whether the gateway may make one upstream call (requirements.md R5).
 *
 * Pure and total, so the whole allowlist — and, more importantly, everything that is not on it —
 * is asserted as a unit test rather than discovered against a live repository.
 *
 * The owner and name are re-checked here even though the client builds them from configuration.
 * That is not redundant: it is the check that a future caller assembling a path by hand cannot
 * quietly point the one credential at a different repository.
 *
 * @param method - HTTP method of the intended call.
 * @param path - Path at the git host, from `/repos/` onwards, query string included or not.
 * @param options - The repository the credential is confined to, and the merge flag.
 * @returns What the call is, or the reason it is refused.
 *
 * @example
 * ```ts
 * checkEndpoint('POST', '/repos/acme/docs/git/trees', { repository: 'acme/docs', allowMergeFromCms: false });
 * // → { ok: true, what: 'create a tree' }
 *
 * checkEndpoint('PUT', '/repos/acme/docs/branches/main/protection', options);
 * // → { ok: false, reason: 'not-allowlisted', ... }
 * ```
 */
export function checkEndpoint(
  method: string,
  path: string,
  options: EndpointPolicyOptions,
): EndpointDecision {
  const match = REPOSITORY_PATH.exec(path.split('?')[0] ?? '');
  if (match === null) {
    return refuse('not-a-repository-path', `"${path}" is not a repository path.`);
  }

  const [, owner, name, rest = ''] = match;
  if (`${String(owner)}/${String(name)}`.toLowerCase() !== options.repository.toLowerCase()) {
    return refuse(
      'other-repository',
      `The CMS credential acts on ${options.repository} and nothing else.`,
    );
  }

  const upperMethod = method.toUpperCase();
  const rule = ALLOWLIST.find(
    (candidate) => candidate.method === upperMethod && candidate.pattern.test(rest),
  );
  if (rule === undefined) {
    return refuse('not-allowlisted', `${upperMethod} ${rest} is not an editorial operation.`);
  }
  if (rule.requiresMergePolicy === true && !options.allowMergeFromCms) {
    return refuse(
      'not-allowlisted',
      'Merging happens in the git host, where branch protection can require an owner approval. ' +
        'Set POLICY_ALLOW_MERGE_FROM_CMS only once that review moves here.',
    );
  }

  return { ok: true, what: rule.what };
}
