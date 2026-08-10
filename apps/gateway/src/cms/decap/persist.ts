import { type DecapContext } from './context';
import { type DecapAsset, resolveAssets } from './media';
import { DRAFT_STATUS } from './protocol';
import { ensureSubmissionOpen } from './unpublished';
import { type DraftFile } from '../drafts';
import { branchForEntry, type EntryRef } from '../entry-branch';

/** One file as Decap sends it, with `newPath` set when the author renamed the entry. */
export interface DecapDataFile {
  readonly path: string;
  readonly slug: string;
  readonly raw: string;
  readonly newPath?: string | undefined;
}

export interface PersistEntryRequest {
  readonly dataFiles: readonly DecapDataFile[];
  /** Images added while the entry was open — requirements.md R15. */
  readonly assets?: readonly DecapAsset[];
  readonly options: {
    readonly commitMessage?: string | undefined;
    readonly collectionName: string;
    readonly status?: string | undefined;
  };
}

/**
 * Saves an entry to its draft branch, and submits it if the author asked for review.
 *
 * Saving and submitting stay separate acts even though Decap can ask for both at once: the draft
 * branch is written first, and a pull request is opened only if the requested status is not
 * `draft`. That is requirements.md R7 — "saving a draft creates or updates a branch and does not
 * open a pull request" — surviving contact with an editor that has no such distinction.
 *
 * A rename arrives as `newPath`, and becomes a write plus a delete in **one** commit. Doing it as
 * two saves would leave a window in which the page existed twice, and a reviewer would see an
 * added file and a deleted file rather than a move.
 *
 * Images the author added arrive here too, as `assets` (requirements.md R15), and go into the same
 * commit as the page. That is the whole of R15's write path: there is no separate upload step, so
 * there is no moment at which an image exists in the repository without the page that shows it, and
 * no write to the default branch. See ADR 0021.
 *
 * @param context - The CMS services and the verified author.
 * @param request - The files and images Decap wants written, and what status it wants them to have.
 * @returns The branch the entry now lives on.
 * @throws {CmsPolicyError} When any path, image or the entry's branch is refused. Nothing is written.
 * @throws {MediaTooLargeError} When an image is over the size limit. Nothing is written.
 */
export async function persistEntry(
  context: DecapContext,
  request: PersistEntryRequest,
): Promise<{ readonly branch: string }> {
  const entry = entryFor(request);
  const branch = branchForEntry(entry, context.settings);

  const files: DraftFile[] = [
    ...request.dataFiles.map((file) => ({
      path: file.newPath ?? file.path,
      content: file.raw,
    })),
    // Checked before the branch is even read, so an oversized image costs no upstream call.
    ...resolveAssets(request.assets ?? [], context.settings),
  ];
  const deletions = request.dataFiles
    .filter((file) => file.newPath !== undefined && file.newPath !== file.path)
    .map((file) => file.path);

  await context.drafts.save(
    { branch, files, deletions, message: request.options.commitMessage },
    context.identity,
  );

  if ((request.options.status ?? DRAFT_STATUS) !== DRAFT_STATUS) {
    await ensureSubmissionOpen(context, entry);
  }

  return { branch };
}

/**
 * The entry a persist request is about.
 *
 * Decap sends one entry's files per call, so every data file carries the same slug and the first
 * is representative.
 */
function entryFor(request: PersistEntryRequest): EntryRef {
  return {
    collection: request.options.collectionName,
    slug: request.dataFiles[0]?.slug ?? '',
  };
}
