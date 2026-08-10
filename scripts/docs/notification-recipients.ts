import { type CodeownersRule, ownersFor } from './codeowners';

/**
 * Only the corpus routes a review notification.
 *
 * CODEOWNERS covers the whole repository, so resolving owners over every changed file would email
 * a code owner on every engineering pull request. R14 is about documentation review routing, and a
 * notification people learn to ignore routes nothing.
 */
export const CORPUS_ROOT = 'docs/';

/** CODEOWNERS handle (`@m-howard`, `@lugem/docs-team`) to the address that hears about it. */
export type OwnerDirectory = Readonly<Record<string, string>>;

export interface RecipientPolicy {
  readonly rules: readonly CodeownersRule[];
  readonly directory: OwnerDirectory;
  /**
   * Domains a notification may be delivered to.
   *
   * The last guard on using a verified sender to mail strangers. `parseSubmitter` already refuses
   * to read an address out of a body the gateway did not write; this bounds the blast radius if
   * that ever slips, and catches a typo in the directory before it becomes mail to a stranger.
   */
  readonly allowedDomains: readonly string[];
}

export interface Recipients {
  /** Addresses to deliver to, de-duplicated, in a stable order. */
  readonly to: readonly string[];
  /**
   * Owners the directory could not place, and addresses outside {@link RecipientPolicy.allowedDomains}.
   *
   * Reported rather than dropped: an owner nobody can reach is a configuration gap, and the only
   * moment anyone would notice is the run that tried to reach them.
   */
  readonly unroutable: readonly string[];
}

function domainOf(address: string): string {
  return (address.split('@')[1] ?? '').toLowerCase();
}

function isDeliverable(address: string, allowedDomains: readonly string[]): boolean {
  return allowedDomains.some((domain) => domainOf(address) === domain.toLowerCase());
}

/**
 * The owners who should review a set of changed paths, as addresses.
 *
 * Paths outside {@link CORPUS_ROOT} are ignored, and each remaining path resolves through
 * CODEOWNERS' last-match-wins rule before the directory turns a handle into an address.
 *
 * @param changedPaths - Repository-root-relative paths in the pull request.
 * @param policy - CODEOWNERS rules, the handle directory, and the deliverable domains.
 * @returns Deliverable addresses, and anything that could not be routed.
 *
 * @example
 * ```ts
 * ownerRecipients(['docs/adr/0006-x.md'], policy);
 * // → { to: ['docs-team@example.com'], unroutable: [] }
 * ```
 */
export function ownerRecipients(
  changedPaths: readonly string[],
  policy: RecipientPolicy,
): Recipients {
  const handles = new Set<string>();
  for (const path of changedPaths.filter((candidate) => candidate.startsWith(CORPUS_ROOT))) {
    for (const owner of ownersFor(path, policy.rules)) {
      handles.add(owner);
    }
  }

  const to = new Set<string>();
  const unroutable = new Set<string>();

  for (const handle of handles) {
    const address = policy.directory[handle];
    if (address === undefined) {
      unroutable.add(`${handle} (no entry in the owner directory)`);
      continue;
    }
    if (!isDeliverable(address, policy.allowedDomains)) {
      unroutable.add(`${handle} → ${address} (outside the permitted domains)`);
      continue;
    }
    to.add(address);
  }

  return { to: [...to].sort(), unroutable: [...unroutable].sort() };
}

/**
 * The submitter's own address, when it is one this system may write to.
 *
 * @param email - The address recovered from the pull request body.
 * @param policy - Supplies the deliverable domains.
 * @returns The address, or nothing routable.
 */
export function submitterRecipients(email: string, policy: RecipientPolicy): Recipients {
  if (!isDeliverable(email, policy.allowedDomains)) {
    return { to: [], unroutable: [`${email} (outside the permitted domains)`] };
  }
  return { to: [email], unroutable: [] };
}
