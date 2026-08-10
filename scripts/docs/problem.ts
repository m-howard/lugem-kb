/**
 * What a content quality gate found, and where.
 *
 * One shape for every check, because requirements.md R13's third criterion — "failures surface as
 * a readable message, not a raw log" — is only achievable if the report can be rendered once. A
 * frontmatter failure and a broken link reach the author through the same sentence, the same
 * annotation and the same pull request comment.
 *
 * `rule` is a closed set for the same reason `KeyPolicyViolation` is in the gateway: callers can
 * branch on it, and a run can be summarised by rule without parsing prose.
 */
export type QualityRule =
  /** No leading `---` block at all, so the page has no title, owner or review date. */
  | 'frontmatter-missing'
  /** A field the corpus requires is absent or empty. */
  | 'frontmatter-required-field'
  /** `last_reviewed` is present but is not a `YYYY-MM-DD` calendar date. */
  | 'frontmatter-date'
  /** The page's path matches no CODEOWNERS entry, so a review request routes to nobody. */
  | 'ownership-unowned'
  /** A relative markdown link points at a file that is not in the corpus. */
  | 'link-target'
  /** A link's `#fragment` matches no heading on the page it points at. */
  | 'link-anchor';

export interface Problem {
  /** Repository-root-relative, POSIX-separated — the form CI annotations and authors both want. */
  readonly file: string;
  /** 1-based. Falls back to the first line when the problem is the whole file. */
  readonly line: number;
  readonly rule: QualityRule;
  /**
   * One sentence, addressed to the person who wrote the page rather than to the person who wrote
   * the checker. An author reading this in a pull request comment has no access to the source.
   */
  readonly message: string;
}
