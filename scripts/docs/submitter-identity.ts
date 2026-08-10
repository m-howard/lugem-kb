/**
 * The line `buildSubmissionBody` writes, read back.
 *
 * `apps/gateway/src/git/attribution.ts` composes it from a verified token; this matches that exact
 * sentence rather than hunting for any address in the body. The strictness is the security
 * property: a hand-written pull request that merely mentions an email address does not match, so
 * it cannot direct a notification at someone who never submitted anything.
 */
const SUBMISSION_LINE =
  /^Submitted by \*\*(.+?)\*\* <([^<>\s]+@[^<>\s]+)> through the documentation CMS\.$/m;

export interface SubmitterIdentity {
  readonly name: string;
  readonly email: string;
}

export interface SubmissionSource {
  /** The pull request body, as the git host holds it. */
  readonly body: string | undefined;
  /** The branch the pull request merges from, e.g. `cms/leave-policy`. */
  readonly headRef: string;
  /** The prefix only the gateway may write under — requirements.md R4. */
  readonly cmsBranchPrefix: string;
}

/**
 * Recovers the human who submitted a draft through the CMS.
 *
 * Two gates, and both are load-bearing. The branch must sit under the CMS prefix, because that
 * prefix is the one place the gateway alone can create (R4) — so the body under it was composed by
 * the gateway from a verified token rather than typed by whoever opened the pull request. And the
 * line must match the sentence the gateway writes, exactly.
 *
 * Without the first gate this function is an open relay: anyone able to open a pull request could
 * write `Submitted by **X** <victim@example.com>` and have a corporate-verified sender deliver mail
 * to an address of their choosing.
 *
 * @param source - The pull request body, its head branch, and the configured CMS branch prefix.
 * @returns The submitter, or `undefined` when this is not a CMS submission.
 *
 * @example
 * ```ts
 * parseSubmitter({
 *   body: 'Submitted by **Sam Okoro** <sam@example.com> through the documentation CMS.',
 *   headRef: 'cms/leave-policy',
 *   cmsBranchPrefix: 'cms/',
 * });
 * // → { name: 'Sam Okoro', email: 'sam@example.com' }
 * ```
 */
export function parseSubmitter(source: SubmissionSource): SubmitterIdentity | undefined {
  if (!source.headRef.startsWith(source.cmsBranchPrefix)) {
    return undefined;
  }

  const match = SUBMISSION_LINE.exec(source.body ?? '');
  const name = match?.[1];
  const email = match?.[2];
  if (name === undefined || email === undefined) {
    return undefined;
  }

  return { name, email };
}
