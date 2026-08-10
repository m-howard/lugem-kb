import { type DecapContext } from './context';
import { branchForEntry, type EntryRef } from '../entry-branch';

/** How Decap spells "the preview is ready". It upper-cases whatever it gets before comparing. */
const READY = 'SUCCESS';

const OPEN_STATE = 'open';

export interface DeployPreview {
  readonly url: string;
  readonly status: string;
}

/**
 * The preview link on an entry's workflow card (requirements.md R12).
 *
 * A preview belongs to a pull request, not to a branch: `.github/workflows/preview.yml` publishes
 * it under `pr-<number>/` and deletes it when the pull request closes. So an entry only has one
 * while its submission is open, and the number the card links to is the submission's.
 *
 * `null` is how Decap spells "no preview for this entry" — it polls, and a null keeps the card
 * saying "check for preview" rather than offering a link to a build that was never made. Every
 * other case here is deliberately that: a draft nobody has submitted yet has no pull request, a
 * merged one has had its preview deleted, and a deployment with no `PREVIEW_BASE_URL` has no
 * preview surface at all.
 *
 * @param context - The CMS services, and the preview base URL when one is configured.
 * @param entry - The collection and slug from Decap's request.
 * @returns The preview link, or `null` when this entry has none.
 *
 * @example
 * ```ts
 * await deployPreviewFor(context, { collection: 'docs', slug: 'leave-policy' });
 * // → { url: 'https://kb.internal/previews/pr-42/', status: 'SUCCESS' }
 * ```
 */
export async function deployPreviewFor(
  context: DecapContext,
  entry: EntryRef,
): Promise<DeployPreview | null> {
  const baseUrl = context.previewBaseUrl;
  if (baseUrl === undefined) {
    return null;
  }

  const branch = branchForEntry(entry, context.settings);
  // `list` asks for `state=all&sort=created&direction=desc` scoped to this head branch, so the
  // first row is the newest attempt at this entry — the same read `unpublished.ts` relies on.
  const submission = (await context.submissions.list(branch))[0];

  if (submission?.state !== OPEN_STATE) {
    return null;
  }

  return { url: `${baseUrl}/pr-${String(submission.number)}/`, status: READY };
}
