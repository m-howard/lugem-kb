/** Extensions the corpus is allowed to contain. Everything else is refused, including inside the docs tree. */
const PERMITTED_EXTENSIONS = ['.md', '.mdx'] as const;

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

/** A prefix is compared as a directory boundary, so `docs` must not match `docs-internal/`. */
function normalisePrefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed === '' ? '' : `${trimmed}/`;
}

function hasPermittedExtension(path: string): boolean {
  return PERMITTED_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension));
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
  if (requestedPath.trim() === '') {
    return refuse('empty-path', 'Document path is empty.');
  }
  if (requestedPath.includes('\0')) {
    return refuse('null-byte', 'Document path contains a null byte.');
  }
  if (requestedPath.includes('\\')) {
    return refuse('backslash', 'Document path contains a backslash.');
  }
  if (requestedPath.startsWith('/')) {
    return refuse('absolute-path', 'Document path must be relative to the corpus prefix.');
  }

  const segments = requestedPath.split('/');
  if (segments.some((segment) => segment === '')) {
    return refuse('empty-segment', 'Document path contains an empty segment.');
  }
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return refuse('traversal', 'Document path contains a relative traversal segment.');
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
