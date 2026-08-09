import { type KeyPolicyViolation, normalisePrefix, resolveDocumentKey } from '../kb/key-policy';

/** A path that is syntactically fine but reaches outside every documentation prefix. */
export type PathPolicyViolation = KeyPolicyViolation | 'outside-prefixes';

export type ResolvedPath =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: PathPolicyViolation; readonly message: string };

export interface PathPolicyOptions {
  /** Repository prefixes the CMS may write under, e.g. `['docs/']`. */
  readonly prefixes: readonly string[];
}

/**
 * Turns configured prefixes into directory-boundary form, dropping any that would match everything.
 *
 * An empty prefix normalises to `''`, and `'anything'.startsWith('')` is true — so a blank entry
 * would silently grant write access to the whole repository. Dropping it fails closed: the path is
 * then refused for being outside every prefix, which is the safe direction to be wrong in.
 */
function writablePrefixes(prefixes: readonly string[]): readonly string[] {
  return prefixes.map(normalisePrefix).filter((prefix) => prefix !== '');
}

/**
 * Resolves a repository path the CMS wants to write, or refuses it (requirements.md R3).
 *
 * The syntactic rules — null bytes, backslashes, empty segments, traversal, permitted extensions —
 * are not restated here. They come from {@link resolveDocumentKey}, which already encodes R3's
 * acceptance table for the corpus reader. One copy means one place to get it right: a second
 * implementation would be a second chance for the two to drift, and the one that drifted wider
 * would be the one nobody noticed.
 *
 * Unlike the S3 reader, the path here is repository-relative and *includes* its prefix, because
 * that is what a commit records. So the prefix is checked rather than prepended.
 *
 * @param requestedPath - Repository-relative path, as the client supplied it.
 * @param options - The prefixes the CMS may write under.
 * @returns The accepted path, or the reason it was refused.
 *
 * @example
 * ```ts
 * resolveWritePath('docs/adr/0013-two-auth-modes.md', { prefixes: ['docs/'] });
 * // → { ok: true, path: 'docs/adr/0013-two-auth-modes.md' }
 *
 * resolveWritePath('.github/workflows/ci.yml', { prefixes: ['docs/'] });
 * // → { ok: false, reason: 'extension', ... }
 * ```
 */
export function resolveWritePath(requestedPath: string, options: PathPolicyOptions): ResolvedPath {
  const resolved = resolveDocumentKey(requestedPath, { prefix: '' });
  if (!resolved.ok) {
    return resolved;
  }

  const prefixes = writablePrefixes(options.prefixes);
  if (!prefixes.some((prefix) => resolved.key.startsWith(prefix))) {
    return {
      ok: false,
      reason: 'outside-prefixes',
      message: `Writes are confined to: ${prefixes.join(', ') || '(none configured)'}.`,
    };
  }

  return { ok: true, path: resolved.key };
}

/**
 * Applies {@link resolveWritePath} to a whole change set, refusing all of it if any entry is bad.
 *
 * R3 asks for this explicitly — "multi-file tree writes are refused if **any** entry violates
 * policy" — and it is the reason the check happens before the upstream call rather than per file
 * as the commit is built. A batch that applied its good half and failed on the rest would leave
 * the repository in a state nobody asked for and no one reviewed.
 *
 * @param requestedPaths - Every path the change set touches, writes and deletions alike.
 * @param options - The prefixes the CMS may write under.
 * @returns Every accepted path, or the first refusal.
 */
export function resolveWritePaths(
  requestedPaths: readonly string[],
  options: PathPolicyOptions,
): { readonly ok: true; readonly paths: readonly string[] } | Extract<ResolvedPath, { ok: false }> {
  const paths: string[] = [];
  for (const requestedPath of requestedPaths) {
    const resolved = resolveWritePath(requestedPath, options);
    if (!resolved.ok) {
      return resolved;
    }
    paths.push(resolved.path);
  }
  return { ok: true, paths };
}
