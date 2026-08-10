import { z } from 'zod';

import { MAX_ASSETS_PER_SAVE } from '../../config';

/**
 * The statuses Decap's editorial workflow board has columns for.
 *
 * The gateway can represent two of them — a draft is a branch, a submission is a pull request —
 * so `pending_publish` is carried as an alias of `pending_review` rather than as a third state.
 * See `unpublished.ts` for why that is the honest mapping and not a shortcut.
 */
export const DRAFT_STATUS = 'draft';
export const PENDING_REVIEW_STATUS = 'pending_review';
export const PENDING_PUBLISH_STATUS = 'pending_publish';

export const DECAP_STATUSES = [
  DRAFT_STATUS,
  PENDING_REVIEW_STATUS,
  PENDING_PUBLISH_STATUS,
] as const;

/** One file as Decap reports it: its content, and enough identity to write it back. */
export interface ImplementationEntry {
  readonly data: string;
  readonly file: {
    readonly path: string;
    readonly id: string;
  };
}

/**
 * One image as Decap reports it.
 *
 * Every field is required by `deserializeMediaFile` in `decap-cms-backend-proxy`: it decodes
 * `content`, builds a blob URL from it, and names the resulting object with `name`. Omitting the
 * content would produce a media library of broken thumbnails rather than an error.
 */
export interface ImplementationMediaFile {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly content: string;
  readonly encoding: 'base64';
}

/** Which files an unpublished entry touches, as the editor's diff view expects them. */
export interface UnpublishedEntryDiff {
  readonly id: string;
  readonly path: string;
  readonly newFile: boolean;
}

export interface UnpublishedEntry {
  readonly slug: string;
  readonly collection: string;
  readonly status: string;
  readonly diffs: readonly UnpublishedEntryDiff[];
  readonly updatedAt: string;
}

/**
 * The envelope Decap's `proxy` backend posts.
 *
 * `branch` arrives both at the top level and inside `params`; only `params` is read, because that
 * is what every action handler already receives. `params` is deliberately loose here — each action
 * parses its own shape, so an unknown action is refused by the dispatcher rather than by a schema
 * that would have to know every action to reject one.
 */
export const proxyRequestSchema = z.object({
  action: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
});

export type ProxyRequest = z.infer<typeof proxyRequestSchema>;

/** Branch is optional throughout: absent means the published corpus, i.e. the default branch. */
const branchParam = z.string().min(1).optional();

export const entriesByFolderParams = z.object({
  branch: branchParam,
  folder: z.string(),
  extension: z.string().optional(),
  depth: z.number().int().positive().optional(),
});

export const entriesByFilesParams = z.object({
  branch: branchParam,
  files: z.array(z.object({ path: z.string().min(1) })),
});

export const getEntryParams = z.object({
  branch: branchParam,
  path: z.string().min(1),
});

/**
 * How Decap names an unpublished entry.
 *
 * It sends either the pair or an `id` that is the pair joined by a slash, depending on which
 * screen the author came from, so both spellings have to resolve to the same draft.
 */
export const unpublishedEntryParams = z.object({
  id: z.string().optional(),
  collection: z.string().optional(),
  slug: z.string().optional(),
});

export const entryKeyParams = z.object({
  collection: z.string().min(1),
  slug: z.string().min(1),
});

export const unpublishedEntryDataFileParams = z.object({
  collection: z.string().min(1),
  slug: z.string().min(1),
  path: z.string().min(1),
});

export const updateUnpublishedEntryStatusParams = z.object({
  collection: z.string().min(1),
  slug: z.string().min(1),
  newStatus: z.enum(DECAP_STATUSES),
});

const dataFileParams = z.object({
  path: z.string().min(1),
  slug: z.string().min(1),
  raw: z.string(),
  /** Set when the author renamed the entry. The old path is deleted in the same commit. */
  newPath: z.string().min(1).optional(),
});

/**
 * One image, as Decap's `serializeAsset` sends it.
 *
 * `base64` is the only encoding accepted rather than the default, because it is the only one Decap
 * produces — and treating an unexpected encoding as base64 would write whatever arrived into the
 * repository as though it were image bytes.
 */
const assetParams = z.object({
  path: z.string().min(1),
  content: z.string(),
  encoding: z.literal('base64'),
});

export const persistEntryParams = z.object({
  dataFiles: z.array(dataFileParams).min(1),
  /**
   * Images the author added while the entry was open — requirements.md R15.
   *
   * Decap holds an upload client-side until the entry is saved and then sends it here, which is what
   * lets the gateway commit the image to the draft branch alongside the page instead of writing it
   * straight to the default branch as Decap's own git backends do. See ADR 0021.
   */
  assets: z.array(assetParams).max(MAX_ASSETS_PER_SAVE).default([]),
  options: z.object({
    commitMessage: z.string().optional(),
    collectionName: z.string().min(1),
    status: z.enum(DECAP_STATUSES).optional(),
  }),
});

/**
 * What the media library asks for. `mediaFolder` is parsed and then ignored — see `decap/media.ts`
 * for why the configured folder wins over the one the browser names.
 */
export const getMediaParams = z.object({
  branch: branchParam,
  mediaFolder: z.string().optional(),
});

export const mediaFileParams = z.object({
  branch: branchParam,
  path: z.string().min(1),
});

export const unpublishedEntryMediaFileParams = z.object({
  collection: z.string().min(1),
  slug: z.string().min(1),
  path: z.string().min(1),
});

export const persistMediaParams = z.object({
  branch: branchParam,
  asset: assetParams,
  options: z.object({ commitMessage: z.string().optional() }).optional(),
});

export const deleteFilesParams = z.object({
  branch: branchParam,
  paths: z.array(z.string().min(1)).min(1),
  options: z.object({ commitMessage: z.string().optional() }).optional(),
});
