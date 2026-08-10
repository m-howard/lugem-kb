import { type DecapContext } from './context';
import { entriesByFiles, entriesByFolder } from './entries';
import { listMedia, readMediaFile, readUnpublishedMediaFile } from './media';
import { persistEntry } from './persist';
import { deployPreviewFor } from './preview';
import {
  deleteFilesParams,
  entriesByFilesParams,
  entriesByFolderParams,
  entryKeyParams,
  getEntryParams,
  getMediaParams,
  mediaFileParams,
  persistEntryParams,
  persistMediaParams,
  type ProxyRequest,
  unpublishedEntryDataFileParams,
  unpublishedEntryMediaFileParams,
  unpublishedEntryParams,
  updateUnpublishedEntryStatusParams,
} from './protocol';
import {
  deleteUnpublishedEntry,
  listUnpublishedEntries,
  publishUnpublishedEntry,
  readUnpublishedEntry,
  resolveEntryRef,
  updateUnpublishedEntryStatus,
} from './unpublished';
import { branchForEntry } from '../entry-branch';
import { UnsupportedActionError } from '../errors';

type ActionHandler = (params: Record<string, unknown>, context: DecapContext) => Promise<unknown>;

/**
 * Actions the gateway answers, and what each one does.
 *
 * Reading this table is meant to be the fastest way to learn what an editor can make this service
 * do. Everything absent from it is refused by {@link dispatch}, which is the same shape of
 * guarantee `git/endpoint-policy.ts` gives for outbound calls — with the difference that this one
 * governs what an author may ask for rather than what the credential may reach.
 */
const ACTIONS: Readonly<Record<string, ActionHandler>> = {
  entriesByFolder: async (params, context) =>
    entriesByFolder(context.reader, entriesByFolderParams.parse(params)),

  entriesByFiles: async (params, context) =>
    entriesByFiles(context.reader, entriesByFilesParams.parse(params)),

  getEntry: async (params, context) => {
    const { path, branch } = getEntryParams.parse(params);
    const document = await context.reader.read(path, branch);
    return { data: document.content, file: { path: document.path, id: document.sha } };
  },

  unpublishedEntries: async (_params, context) => listUnpublishedEntries(context),

  unpublishedEntry: async (params, context) =>
    readUnpublishedEntry(context, resolveEntryRef(unpublishedEntryParams.parse(params))),

  unpublishedEntryDataFile: async (params, context) => {
    const request = unpublishedEntryDataFileParams.parse(params);
    const branch = branchForEntry(request, context.settings);
    const document = await context.reader.read(request.path, branch);
    return document.content;
  },

  persistEntry: async (params, context) => persistEntry(context, persistEntryParams.parse(params)),

  updateUnpublishedEntryStatus: async (params, context) =>
    updateUnpublishedEntryStatus(context, updateUnpublishedEntryStatusParams.parse(params)),

  publishUnpublishedEntry: async (params, context) => {
    await publishUnpublishedEntry(context, entryKeyParams.parse(params));
    return null;
  },

  deleteUnpublishedEntry: async (params, context) => {
    await deleteUnpublishedEntry(context, entryKeyParams.parse(params));
    return null;
  },

  // requirements.md R15. The media library, listing the configured folder on the published corpus.
  getMedia: async (params, context) => {
    getMediaParams.parse(params);
    return listMedia(context);
  },

  getMediaFile: async (params, context) => readMediaFile(context, mediaFileParams.parse(params)),

  // Read from the draft's own branch, which is what keeps an image visible after a reload — the
  // published corpus does not have it yet.
  unpublishedEntryMediaFile: async (params, context) =>
    readUnpublishedMediaFile(context, unpublishedEntryMediaFileParams.parse(params)),

  // Decap sends this only for an upload made from the standalone media library, outside any entry —
  // and its own git backends answer it by committing straight to the default branch, which branch
  // policy and branch protection both refuse here. Refused with somewhere to go instead: an image
  // added from inside a page travels with it (ADR 0021).
  persistMedia: (params) => {
    persistMediaParams.parse(params);
    throw new UnsupportedActionError(
      'persistMedia',
      'Add the image from inside the page that will show it, rather than from the media library. ' +
        'An image is reviewed and published with its page, so it has to travel with one.',
    );
  },

  // Decap's proxy backend does not implement deletion, so this is defence rather than a live path.
  // Removing a published image is a change to the corpus, exactly as removing a page is.
  deleteMedia: () => {
    throw new UnsupportedActionError(
      'deleteMedia',
      'Removing a published image is a reviewed change. Take it out of the page in a draft and ' +
        'submit that for review.',
    );
  },

  // requirements.md R12. Answers `null` — Decap's spelling of "no preview for this entry" — for a
  // draft with no open submission, and on any deployment with no preview bucket configured.
  getDeployPreview: async (params, context) =>
    deployPreviewFor(context, resolveEntryRef(unpublishedEntryParams.parse(params))),

  // Deleting a *published* page is a change to the corpus and has to be reviewed like any other.
  // Decap would send it as a direct write, which branch policy refuses anyway; refusing it here
  // gives the author a reason instead of a policy error about a branch they never chose.
  deleteFiles: (params) => {
    deleteFilesParams.parse(params);
    throw new UnsupportedActionError(
      'deleteFiles',
      'Removing a published page is a reviewed change. Delete the page in a draft and submit it ' +
        'for review, rather than deleting it directly.',
    );
  },
};

/**
 * Runs one Decap action against the CMS services.
 *
 * @param request - The parsed proxy envelope.
 * @param context - The CMS services and the verified author.
 * @returns Whatever the action answers, ready to serialise as JSON.
 * @throws {UnsupportedActionError} When the action is not one this gateway offers.
 * @throws {CmsPolicyError} When a policy refuses the request.
 *
 * @example
 * ```ts
 * await dispatch({ action: 'unpublishedEntries', params: {} }, context);
 * // → ['guides/leave-policy']
 * ```
 */
export async function dispatch(request: ProxyRequest, context: DecapContext): Promise<unknown> {
  const handler = ACTIONS[request.action];
  if (handler !== undefined) {
    return handler(request.params, context);
  }

  throw new UnsupportedActionError(
    request.action,
    `"${request.action}" is not an operation this documentation CMS performs.`,
  );
}
