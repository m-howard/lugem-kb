import { CmsPolicyError } from './errors';
import { type CmsSettings } from './settings';
import { resolveBranch } from '../git/branch-policy';
import { normalisePrefix } from '../kb/key-policy';

/** A CMS entry as the editor names it: which collection it belongs to, and its slug within it. */
export interface EntryRef {
  readonly collection: string;
  readonly slug: string;
}

/**
 * Names the draft branch that holds one entry.
 *
 * The branch name *is* the storage for "which entry is this draft", so it has to survive a round
 * trip through {@link parseEntryBranch}. That is why the collection may not contain a slash while
 * the slug may: splitting on the first separator then gives back exactly what went in, and Decap's
 * nested-folder collections keep working.
 *
 * Validation is delegated to {@link resolveBranch} rather than restated here. An editor is free to
 * configure `slug: "{{title}}"`, which produces spaces — and a space is a character git refuses in
 * a ref. Restating that rule in a second place would mean two chances for the two copies to
 * disagree about what is writable.
 *
 * @param entry - The collection and slug the editor supplied.
 * @param settings - The CMS branch prefix and default branch.
 * @returns The draft branch name.
 * @throws {CmsPolicyError} When the entry cannot name a branch the CMS is allowed to write.
 *
 * @example
 * ```ts
 * branchForEntry({ collection: 'guides', slug: 'leave-policy' }, settings);
 * // → 'cms/guides/leave-policy'
 * ```
 */
export function branchForEntry(entry: EntryRef, settings: CmsSettings): string {
  const collection = entry.collection.trim();
  const slug = entry.slug.trim();

  if (collection === '' || slug === '') {
    throw new CmsPolicyError('invalid-entry', 'An entry needs both a collection and a slug.');
  }
  if (collection.includes('/')) {
    throw new CmsPolicyError(
      'invalid-entry',
      `Collection "${collection}" contains a slash, which would make its draft branch ambiguous.`,
    );
  }

  const candidate = `${normalisePrefix(settings.branchPrefix)}${collection}/${slug}`;
  const resolved = resolveBranch(candidate, {
    prefix: settings.branchPrefix,
    defaultBranch: settings.defaultBranch,
    operation: 'update',
  });
  if (!resolved.ok) {
    throw new CmsPolicyError(
      resolved.reason,
      `"${collection}/${slug}" cannot be saved as a draft: ${resolved.message}`,
    );
  }

  return resolved.branch;
}

/**
 * Recovers the entry a draft branch holds, or `undefined` when the branch is not one of ours.
 *
 * Total rather than throwing, because its caller is listing every branch under the prefix and a
 * branch some other tool created there is a thing to skip, not an error to raise.
 *
 * @param branch - Branch name, without the `refs/heads/` qualifier.
 * @param branchPrefix - Prefix the CMS owns, e.g. `cms/`.
 * @returns The collection and slug, or `undefined`.
 *
 * @example
 * ```ts
 * parseEntryBranch('cms/guides/leave-policy', 'cms/');
 * // → { collection: 'guides', slug: 'leave-policy' }
 * ```
 */
export function parseEntryBranch(branch: string, branchPrefix: string): EntryRef | undefined {
  const prefix = normalisePrefix(branchPrefix);
  if (prefix === '' || !branch.startsWith(prefix)) {
    return undefined;
  }

  const rest = branch.slice(prefix.length);
  const separator = rest.indexOf('/');
  // `<= 0` covers both "no collection separator at all" and a leading slash, which would mean an
  // empty collection name.
  if (separator <= 0 || separator === rest.length - 1) {
    return undefined;
  }

  return { collection: rest.slice(0, separator), slug: rest.slice(separator + 1) };
}
