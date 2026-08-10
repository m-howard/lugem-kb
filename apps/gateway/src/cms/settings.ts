/**
 * What the CMS is allowed to touch, in one value.
 *
 * Passed as a unit rather than as four arguments so that every service resolves paths and
 * branches against the same rules. A service that took only the prefixes it happened to need
 * would be one refactor away from checking a path against the branch policy's idea of the
 * repository.
 */
export interface CmsSettings {
  /** `owner/name` of the corpus repository. */
  readonly repository: string;
  /** Where reviewed content lives, and the only base a pull request may target. */
  readonly defaultBranch: string;
  /** Branch prefix the CMS owns — requirements.md R4. */
  readonly branchPrefix: string;
  /** Repository prefixes the CMS may write under — requirements.md R3. */
  readonly pathPrefixes: readonly string[];
  /**
   * The one folder uploads are confined to — requirements.md R15.
   *
   * Narrower than {@link pathPrefixes} on purpose: those say where *pages* may be written, and an
   * image is not a page. See [ADR 0021](../../../../docs/adr/0021-images-travel-with-the-draft.md).
   */
  readonly mediaFolder: string;
  /** Largest single upload, in bytes — requirements.md R15. */
  readonly maxUploadBytes: number;
}
