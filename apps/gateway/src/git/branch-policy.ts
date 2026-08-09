import { normalisePrefix } from '../kb/key-policy';

const HEADS_PREFIX = 'refs/heads/';

/**
 * Characters git rejects in a ref name, plus the ones that are merely dangerous.
 *
 * This is not the complete `git check-ref-format` grammar. It is the subset that stops a branch
 * name being read as something other than a branch name — a path, a ref-log expression, a glob.
 * Everything else is left to the git host, which will refuse it authoritatively.
 */
const FORBIDDEN_CHARACTERS = /[~^:?*[\\]/;

/**
 * Traversal, empty or leading-dot segments, a `.lock` suffix, the bare `@` git reserves, and the
 * `@{` that opens a ref-log expression — `cms/pricing@{1}` names a past value of the ref, not a
 * branch.
 */
const FORBIDDEN_SHAPES = /\.\.|^\/|\/$|\/\/|\.lock$|^@$|@\{|(^|\/)\./;

const SPACE_CODE_POINT = 0x20;
const DELETE_CODE_POINT = 0x7f;

/** A scan rather than a regex, so the control range does not have to be spelled inside a pattern. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= SPACE_CODE_POINT || codePoint === DELETE_CODE_POINT) {
      return true;
    }
  }
  return false;
}

export type BranchOperation = 'create' | 'update' | 'delete' | 'read';

export type BranchPolicyViolation = 'empty' | 'malformed' | 'default-branch' | 'outside-prefix';

export type ResolvedBranch =
  | { readonly ok: true; readonly branch: string; readonly ref: string }
  | { readonly ok: false; readonly reason: BranchPolicyViolation; readonly message: string };

export interface BranchPolicyOptions {
  /** Prefix the CMS owns, e.g. `cms/`. */
  readonly prefix: string;
  readonly defaultBranch: string;
  readonly operation: BranchOperation;
}

function refuse(reason: BranchPolicyViolation, message: string): ResolvedBranch {
  return { ok: false, reason, message };
}

/**
 * Resolves a branch the CMS names, or refuses it (requirements.md R4).
 *
 * `refs/heads/cms/pricing` and `cms/pricing` resolve identically, so the policy cannot be dodged
 * by qualifying the name — the git data API accepts both spellings for the same branch, and a
 * check that understood only one of them would be a check in name only.
 *
 * Reads are allowed on the default branch and on the CMS's own branches, and refused elsewhere.
 * R4 governs create, update and delete; confining reads too is deliberately stricter than asked,
 * because the editorial workflow never legitimately reads a third party's branch and forbidding
 * it costs nothing.
 *
 * @param requested - Branch name or full ref, as the client supplied it.
 * @param options - The CMS prefix, the repository's default branch, and what is being attempted.
 * @returns The branch and its qualified ref, or the reason it was refused.
 *
 * @example
 * ```ts
 * resolveBranch('cms/pricing', { prefix: 'cms/', defaultBranch: 'main', operation: 'create' });
 * // → { ok: true, branch: 'cms/pricing', ref: 'refs/heads/cms/pricing' }
 *
 * resolveBranch('main', { prefix: 'cms/', defaultBranch: 'main', operation: 'update' });
 * // → { ok: false, reason: 'default-branch', ... }
 * ```
 */
export function resolveBranch(requested: string, options: BranchPolicyOptions): ResolvedBranch {
  const branch = (
    requested.startsWith(HEADS_PREFIX) ? requested.slice(HEADS_PREFIX.length) : requested
  ).trim();

  if (branch === '') {
    return refuse('empty', 'No branch was named.');
  }
  if (
    hasControlCharacter(branch) ||
    FORBIDDEN_CHARACTERS.test(branch) ||
    FORBIDDEN_SHAPES.test(branch)
  ) {
    return refuse('malformed', `"${branch}" is not a usable branch name.`);
  }

  if (branch === options.defaultBranch) {
    if (options.operation === 'read') {
      return { ok: true, branch, ref: `${HEADS_PREFIX}${branch}` };
    }
    return refuse(
      'default-branch',
      `The default branch "${branch}" is published content. Changes reach it by review, not by ` +
        'a write from the CMS.',
    );
  }

  const prefix = normalisePrefix(options.prefix);
  if (prefix === '' || !branch.startsWith(prefix)) {
    return refuse('outside-prefix', `The CMS may only touch branches under "${prefix}".`);
  }

  return { ok: true, branch, ref: `${HEADS_PREFIX}${branch}` };
}
