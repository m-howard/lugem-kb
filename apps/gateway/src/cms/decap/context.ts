import { type Identity } from '../../auth/claims';
import { type GitHubClient } from '../../git/github-client';
import { type DocumentReader } from '../documents';
import { type DraftService } from '../drafts';
import { type MediaService } from '../media';
import { type CmsSettings } from '../settings';
import { type SubmissionService } from '../submissions';

/**
 * What every Decap action needs to do its work.
 *
 * These are the same services the REST routes use, and that is the point of the adapter: the
 * protocol changes, the policies do not. Nothing here reaches the git host except through
 * `client`, which checks the endpoint allowlist before it reads the credential.
 */
export interface DecapContext {
  readonly reader: DocumentReader;
  readonly drafts: DraftService;
  readonly submissions: SubmissionService;
  /** Reads uploaded images — requirements.md R15. Writing them is `drafts`, with the page. */
  readonly media: MediaService;
  readonly settings: CmsSettings;
  /** Only for enumerating draft branches — the one read the services do not express. */
  readonly client: GitHubClient;
  /**
   * The verified author, which is why this is built per request rather than once at start-up.
   * Every commit and pull request the adapter creates is attributed from here and from nowhere
   * else — the protocol has no field an editor could use to name someone else (requirements.md R6).
   */
  readonly identity: Identity;
  /**
   * Where pull request previews are served from, e.g. `https://kb.internal/previews`.
   *
   * Absent when `PREVIEW_BUCKET` is unset, which is what makes previews optional: `getDeployPreview`
   * then answers `null` and the workflow card offers no link, exactly as it did before R12.
   */
  readonly previewBaseUrl?: string | undefined;
}
