import { type DecapContext } from './context';
import {
  DRAFT_STATUS,
  PENDING_REVIEW_STATUS,
  type UnpublishedEntry,
  type UnpublishedEntryDiff,
} from './protocol';
import { resolveDraftPaths } from '../../git/path-policy';
import { listDraftBranches } from '../draft-branches';
import { branchForEntry, type EntryRef, parseEntryBranch } from '../entry-branch';
import { CmsPolicyError, DraftMissingError } from '../errors';
import { type Submission } from '../submissions';
import { readBranchSnapshot, readTreeEntries } from '../tree';

const MERGED_STATE = 'merged';
const OPEN_STATE = 'open';

/** How Decap spells an entry when it sends one identifier instead of the pair. */
export function contentKey(entry: EntryRef): string {
  return `${entry.collection}/${entry.slug}`;
}

/**
 * Works out which entry a request is about.
 *
 * Decap sends the collection and slug from some screens and a joined `id` from others, so both
 * have to land on the same draft or an author's card would behave differently depending on where
 * they clicked it.
 *
 * @param params - Whatever identifiers the action carried.
 * @returns The entry.
 * @throws {CmsPolicyError} When the request names no entry at all.
 */
export function resolveEntryRef(params: {
  readonly id?: string | undefined;
  readonly collection?: string | undefined;
  readonly slug?: string | undefined;
}): EntryRef {
  if (params.collection !== undefined && params.slug !== undefined) {
    return { collection: params.collection, slug: params.slug };
  }

  const separator = params.id?.indexOf('/') ?? -1;
  if (params.id !== undefined && separator > 0 && separator < params.id.length - 1) {
    return { collection: params.id.slice(0, separator), slug: params.id.slice(separator + 1) };
  }

  throw new CmsPolicyError('invalid-entry', 'This request does not name a collection and slug.');
}

/**
 * Lists the entries with work in progress.
 *
 * A draft is a branch, so this is a branch listing. Whether each one is still open is settled per
 * entry by {@link readUnpublishedEntry} — which is how Decap asks anyway, and saves a pull request
 * lookup per draft here.
 *
 * @param context - The CMS services.
 * @returns Content keys, one per draft.
 */
export async function listUnpublishedEntries(context: DecapContext): Promise<readonly string[]> {
  const branches = await listDraftBranches(context.client, context.settings.branchPrefix);

  return branches
    .map((branch) => parseEntryBranch(branch, context.settings.branchPrefix))
    .filter((entry): entry is EntryRef => entry !== undefined)
    .map(contentKey);
}

/** The newest pull request for a branch, whatever state it is in. */
async function newestSubmission(
  context: DecapContext,
  branch: string,
): Promise<Submission | undefined> {
  // `list` asks the git host for `state=all&sort=created&direction=desc`, scoped to this head
  // branch, so the first row is the newest attempt at this entry.
  const submissions = await context.submissions.list(branch);
  return submissions[0];
}

/**
 * Reads one unpublished entry: its status, the files it touches, and when it last moved.
 *
 * @param context - The CMS services.
 * @param entry - The collection and slug.
 * @returns The entry as Decap's editorial workflow expects it.
 * @throws {DraftMissingError} When there is no draft branch, or the draft is already published.
 * @throws {CmsPolicyError} When the entry cannot name a branch the CMS owns.
 */
export async function readUnpublishedEntry(
  context: DecapContext,
  entry: EntryRef,
): Promise<UnpublishedEntry> {
  const branch = branchForEntry(entry, context.settings);
  const snapshot = await readBranchSnapshot(context.client, branch);
  if (snapshot === undefined) {
    throw new DraftMissingError(contentKey(entry));
  }

  const submission = await newestSubmission(context, branch);
  if (submission?.state === MERGED_STATE) {
    // The branch outlived its pull request. The work is published, so it is not in progress —
    // telling Decap it is would put a card on the board that can never be moved off it.
    throw new DraftMissingError(contentKey(entry));
  }

  return {
    slug: entry.slug,
    collection: entry.collection,
    status: submission?.state === OPEN_STATE ? PENDING_REVIEW_STATUS : DRAFT_STATUS,
    diffs: await readDiffs(context, branch),
    updatedAt: snapshot.updatedAt ?? '',
  };
}

/**
 * Works out which files the draft changes relative to the published corpus.
 *
 * Compared by blob sha rather than by content: identical content has an identical sha, so a file
 * an author opened and saved unchanged does not show up as a change.
 *
 * Images count as changed files, not only pages (requirements.md R15). Decap derives an entry's
 * media from exactly this list — everything in it that is not a page, it asks for through
 * `unpublishedEntryMediaFile` — so leaving images out would make an uploaded screenshot disappear
 * from the editor the moment the author reloaded, while sitting on the branch all along.
 *
 * @param context - The CMS services.
 * @param branch - The draft branch.
 * @returns One diff per changed or added file, pages first.
 */
async function readDiffs(
  context: DecapContext,
  branch: string,
): Promise<readonly UnpublishedEntryDiff[]> {
  const [draft, published] = await Promise.all([
    readEntryFiles(context, branch),
    readEntryFiles(context, context.settings.defaultBranch),
  ]);

  const publishedShas = new Map(published.map((file) => [file.path, file.sha]));

  return draft
    .filter((file) => publishedShas.get(file.path) !== file.sha)
    .map((file) => ({
      id: file.sha,
      path: file.path,
      newFile: !publishedShas.has(file.path),
    }));
}

/**
 * Every file on a branch that an entry could consist of: its pages and its images.
 *
 * Reads the branch **once**. Asking `DocumentReader` for the pages and `MediaService` for the
 * images would be the obvious composition and costs twice as much — each resolves the ref, reads
 * its commit and walks the tree, so the two together read the same tree twice. The board asks this
 * per card on every refresh, which makes it the one listing worth spending a private function on.
 *
 * The predicate is `resolveDraftPaths`, the same combined rule that decides what a draft may
 * *write*, so a file that could not have been committed here is not reported as a change either.
 *
 * Both callers pass a branch that policy has already accepted — `branchForEntry` for the draft, and
 * the configured default branch — so there is no third branch check to lose.
 */
async function readEntryFiles(
  context: DecapContext,
  branch: string,
): Promise<readonly { readonly path: string; readonly sha: string }[]> {
  const snapshot = await readBranchSnapshot(context.client, branch);
  if (snapshot === undefined) {
    return [];
  }

  const entries = await readTreeEntries(context.client, snapshot.treeSha);
  const { pathPrefixes, mediaFolder } = context.settings;

  return entries.filter(
    (entry) => resolveDraftPaths([entry.path], { prefixes: pathPrefixes, mediaFolder }).ok,
  );
}

/**
 * Moves an entry between the board's columns.
 *
 * The two transitions that exist here are the two the gateway can represent: submitting opens a
 * pull request, withdrawing closes it. `pending_publish` is treated as `pending_review` because
 * publishing is not a CMS action at all — approval happens in the git host, where branch
 * protection can require a code owner (requirements.md R7, R8).
 *
 * @param context - The CMS services.
 * @param request - The entry and the status the author dragged it to.
 * @returns The entry's state afterwards.
 */
export async function updateUnpublishedEntryStatus(
  context: DecapContext,
  request: EntryRef & { readonly newStatus: string },
): Promise<UnpublishedEntry> {
  if (request.newStatus === DRAFT_STATUS) {
    await withdrawSubmission(context, request);
  } else {
    await ensureSubmissionOpen(context, request);
  }

  return readUnpublishedEntry(context, request);
}

/**
 * Opens a pull request for an entry unless one is already open.
 *
 * Idempotent because both routes into review are: an author can drag a card to "in review", or
 * save an entry that Decap already considers submitted. Neither should produce a second pull
 * request for the same draft.
 *
 * @param context - The CMS services.
 * @param entry - The collection and slug.
 */
export async function ensureSubmissionOpen(context: DecapContext, entry: EntryRef): Promise<void> {
  const branch = branchForEntry(entry, context.settings);
  const submission = await newestSubmission(context, branch);
  if (submission?.state === OPEN_STATE) {
    return;
  }

  await context.submissions.submit(
    { branch, title: submissionTitle(entry), summary: undefined },
    context.identity,
  );
}

/**
 * Takes an entry back out of review, leaving its draft branch alone.
 *
 * @param context - The CMS services.
 * @param entry - The collection and slug.
 */
async function withdrawSubmission(context: DecapContext, entry: EntryRef): Promise<void> {
  const branch = branchForEntry(entry, context.settings);
  const submission = await newestSubmission(context, branch);
  if (submission?.state === OPEN_STATE) {
    await context.submissions.close(submission.number);
  }
}

/**
 * A title for a submission the author never gave one.
 *
 * Decap's board has no title field — the status transition carries only the entry — so this is
 * derived rather than asked for. It reads as a change description in the pull request list, which
 * is where a reviewer meets it.
 */
function submissionTitle(entry: EntryRef): string {
  return `docs: update ${entry.slug}`;
}

/**
 * Publishes an entry by merging its submission.
 *
 * Refused by default, and that is the design rather than a gap: R7 puts approval in the git host,
 * where branch protection can require a code owner and no principal — including the App — can
 * bypass it. `SubmissionService.merge` raises the refusal, and the flag that would lift it is
 * `POLICY_ALLOW_MERGE_FROM_CMS` (requirements.md R16).
 *
 * @param context - The CMS services.
 * @param entry - The collection and slug.
 * @throws {DraftMissingError} When the entry has no open submission to publish.
 * @throws {CmsPolicyError} When merging from the CMS is disabled, which is the default.
 */
export async function publishUnpublishedEntry(
  context: DecapContext,
  entry: EntryRef,
): Promise<void> {
  const branch = branchForEntry(entry, context.settings);
  const submission = await newestSubmission(context, branch);
  if (submission?.state !== OPEN_STATE) {
    throw new DraftMissingError(contentKey(entry));
  }

  await context.submissions.merge(submission.number);
}

/**
 * Discards a draft: closes its submission if it has one, then deletes the branch.
 *
 * In that order on purpose. Deleting the branch first would leave the pull request open with no
 * head, which the git host closes on its own but reports oddly in the meantime.
 *
 * @param context - The CMS services.
 * @param entry - The collection and slug.
 * @throws {CmsPolicyError} When the entry cannot name a branch the CMS owns.
 */
export async function deleteUnpublishedEntry(
  context: DecapContext,
  entry: EntryRef,
): Promise<void> {
  const branch = branchForEntry(entry, context.settings);
  const submission = await newestSubmission(context, branch);

  if (submission?.state === OPEN_STATE) {
    await context.submissions.close(submission.number);
  }

  await context.drafts.discard(branch);
}
