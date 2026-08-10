import { type DecapContext } from './context';
import { entriesByFiles, entriesByFolder } from './entries';
import { persistEntry } from './persist';
import {
  deleteFilesParams,
  entriesByFilesParams,
  entriesByFolderParams,
  entryKeyParams,
  getEntryParams,
  persistEntryParams,
  type ProxyRequest,
  unpublishedEntryDataFileParams,
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

  // The media library is shown but empty. `PERMITTED_EXTENSIONS` is markdown only, so there is
  // nothing this could list — and answering with a list rather than an error keeps the editor's
  // media button from looking broken (requirements.md R15 is a separate, later change).
  getMedia: () => Promise.resolve([]),

  // Previews are Phase 3's other half (requirements.md R12). `null` is how Decap spells "no
  // preview for this entry", so this is the seam that work plugs into rather than a stub.
  getDeployPreview: () => Promise.resolve(null),

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

const MEDIA_ACTIONS: readonly string[] = [
  'getMediaFile',
  'persistMedia',
  'deleteMedia',
  'unpublishedEntryMediaFile',
];

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

  if (MEDIA_ACTIONS.includes(request.action)) {
    throw new UnsupportedActionError(
      request.action,
      'This documentation CMS stores markdown only, so it cannot hold images or other media.',
    );
  }

  throw new UnsupportedActionError(
    request.action,
    `"${request.action}" is not an operation this documentation CMS performs.`,
  );
}
