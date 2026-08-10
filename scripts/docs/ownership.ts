import { type CodeownersRule, ownersFor } from './codeowners';
import { type Problem } from './problem';

/**
 * Checks that every corpus page routes to somebody (requirements.md R8, R13).
 *
 * `.github/CODEOWNERS` says it in its own header: "a page whose owner has no CODEOWNERS entry
 * routes to nobody". The frontmatter `owner` field names the team in prose; this is what turns it
 * into a review request the git host will actually send, and into the team the gap report names
 * when a reader's question finds no answer.
 *
 * Reuses {@link ownersFor}, the same matcher the gap report uses, so the two can never disagree
 * about who owns a page.
 *
 * @param files - Repository-root-relative page paths.
 * @param rules - Parsed CODEOWNERS rules, in file order.
 * @returns One problem per unowned page.
 *
 * @example
 * ```ts
 * checkOwnership(['docs/leave.md'], parseCodeowners('/docs/ @people-team'));
 * // → []
 * ```
 */
export function checkOwnership(
  files: readonly string[],
  rules: readonly CodeownersRule[],
): readonly Problem[] {
  return files
    .filter((file) => ownersFor(file, rules).length === 0)
    .map((file) => ({
      file,
      line: 1,
      rule: 'ownership-unowned' as const,
      message:
        'No CODEOWNERS entry matches this page, so a review request for it routes to nobody. ' +
        'Add a rule covering its directory to .github/CODEOWNERS.',
    }));
}
