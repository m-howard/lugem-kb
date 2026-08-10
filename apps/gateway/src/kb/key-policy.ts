/** Extensions the corpus is allowed to contain. Everything else is refused, including inside the docs tree. */
export const PERMITTED_EXTENSIONS = ['.md', '.mdx'] as const;

/** Why a requested path was refused. Kept as a closed set so callers can branch and logs can be aggregated. */
export type KeyPolicyViolation =
  | 'empty-path'
  | 'null-byte'
  | 'backslash'
  | 'absolute-path'
  | 'empty-segment'
  | 'traversal'
  | 'extension'
  | 'prefix-escape';

export type ResolvedKey =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly reason: KeyPolicyViolation; readonly message: string };

function refuse(reason: KeyPolicyViolation, message: string): ResolvedKey {
  return { ok: false, reason, message };
}

/**
 * Normalises a corpus prefix to a directory boundary, so `docs` cannot match `docs-internal/`.
 *
 * Exported because every place that compares a key against the prefix has to agree on where the
 * boundary is. Three copies of this rule would be three chances for one of them to drift and
 * quietly widen what a caller can reach.
 *
 * @param prefix - Prefix as configured, with or without surrounding slashes.
 * @returns The prefix with exactly one trailing slash, or `''` for an empty prefix.
 */
export function normalisePrefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed === '' ? '' : `${trimmed}/`;
}

function hasPermittedExtension(path: string): boolean {
  return PERMITTED_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension));
}

/**
 * Checks the rules that hold for every repository path, whatever it is allowed to contain.
 *
 * Extension is deliberately **not** among them. What a path may end in depends on what it is for —
 * the corpus holds markdown, the media folder holds images — while null bytes, backslashes, absolute
 * paths, empty segments and traversal are refused everywhere. Splitting the two apart is what lets
 * `git/media-policy.ts` share these rules without widening {@link PERMITTED_EXTENSIONS}, which would
 * have let an image into the S3 corpus reader as well.
 *
 * @param requestedPath - Path as supplied by the client.
 * @returns The reason it is refused, or `undefined` when it is syntactically fine.
 *
 * @example
 * ```ts
 * checkPathSyntax('docs/a/../b.md'); // → { reason: 'traversal', message: '...' }
 * checkPathSyntax('docs/index.md');  // → undefined
 * ```
 */
export function checkPathSyntax(
  requestedPath: string,
): { readonly reason: KeyPolicyViolation; readonly message: string } | undefined {
  if (requestedPath.trim() === '') {
    return { reason: 'empty-path', message: 'Document path is empty.' };
  }
  if (requestedPath.includes('\0')) {
    return { reason: 'null-byte', message: 'Document path contains a null byte.' };
  }
  if (requestedPath.includes('\\')) {
    return { reason: 'backslash', message: 'Document path contains a backslash.' };
  }
  if (requestedPath.startsWith('/')) {
    return {
      reason: 'absolute-path',
      message: 'Document path must be relative to the corpus prefix.',
    };
  }

  const segments = requestedPath.split('/');
  if (segments.some((segment) => segment === '')) {
    return { reason: 'empty-segment', message: 'Document path contains an empty segment.' };
  }
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return { reason: 'traversal', message: 'Document path contains a relative traversal segment.' };
  }

  return undefined;
}

/**
 * Turns a client-supplied document path into an S3 key confined to the corpus prefix, or refuses it.
 *
 * Every refusal happens here, before any upstream call, so a policy failure can never partially
 * apply (requirements.md R3). The function is pure and total: it performs no I/O and throws
 * nothing, which is what lets the whole R3 acceptance table be asserted as a unit test.
 *
 * Refusal precedes normalisation deliberately. Collapsing `a/../b` into `b` and then allowing it
 * would mean the policy's answer depends on a normaliser the caller cannot see; rejecting the
 * traversal outright keeps the rule legible.
 *
 * @param requestedPath - Path as supplied by the client, relative to the corpus prefix.
 * @param options - `prefix` is the corpus key prefix, with or without a trailing slash.
 * @returns The resolved key, or the reason it was refused.
 *
 * @example
 * ```ts
 * resolveDocumentKey('adr/0001-monorepo.md', { prefix: 'docs/' });
 * // → { ok: true, key: 'docs/adr/0001-monorepo.md' }
 *
 * resolveDocumentKey('../.github/workflows/ci.yml', { prefix: 'docs/' });
 * // → { ok: false, reason: 'traversal', ... }
 * ```
 */
export function resolveDocumentKey(
  requestedPath: string,
  options: { readonly prefix: string },
): ResolvedKey {
  const syntax = checkPathSyntax(requestedPath);
  if (syntax !== undefined) {
    return refuse(syntax.reason, syntax.message);
  }
  if (!hasPermittedExtension(requestedPath)) {
    return refuse(
      'extension',
      `Document path must end in one of: ${PERMITTED_EXTENSIONS.join(', ')}.`,
    );
  }

  const prefix = normalisePrefix(options.prefix);
  const key = `${prefix}${requestedPath}`;

  // Defence in depth: the checks above should make this unreachable, but a key that escaped the
  // prefix is the one failure worth catching twice.
  if (!key.startsWith(prefix)) {
    return refuse('prefix-escape', 'Resolved key falls outside the corpus prefix.');
  }

  return { ok: true, key };
}

/**
 * Applies {@link resolveDocumentKey} to a batch, refusing the whole batch if any entry violates
 * policy (requirements.md R3: multi-file writes are refused if *any* entry is bad).
 *
 * @param requestedPaths - Paths to resolve.
 * @param options - `prefix` is the corpus key prefix.
 * @returns Every resolved key, or the first refusal encountered.
 */
export function resolveDocumentKeys(
  requestedPaths: readonly string[],
  options: { readonly prefix: string },
): { readonly ok: true; readonly keys: readonly string[] } | Extract<ResolvedKey, { ok: false }> {
  const keys: string[] = [];
  for (const requestedPath of requestedPaths) {
    const resolved = resolveDocumentKey(requestedPath, options);
    if (!resolved.ok) {
      return resolved;
    }
    keys.push(resolved.key);
  }
  return { ok: true, keys };
}
