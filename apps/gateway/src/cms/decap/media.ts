import { type DecapContext } from './context';
import { type ImplementationMediaFile } from './protocol';
import { checkMediaSignature, checkMediaSize, resolveMediaPath } from '../../git/media-policy';
import { type DraftFile } from '../drafts';
import { branchForEntry, type EntryRef } from '../entry-branch';
import { CmsPolicyError, MediaTooLargeError } from '../errors';
import { type MediaFile } from '../media';
import { type CmsSettings } from '../settings';

/** How many leading bytes a format signature needs. Decoding more than this to check four bytes is waste. */
const SIGNATURE_BYTES = 16;

/** One image, in the shape Decap's `deserializeMediaFile` reads. */
function toMediaFile(file: MediaFile): ImplementationMediaFile {
  return {
    id: file.sha,
    path: file.path,
    name: file.name,
    content: file.content,
    encoding: 'base64',
  };
}

/**
 * Lists the media library (requirements.md R15).
 *
 * The `mediaFolder` Decap sends is deliberately not honoured. It comes from the browser's copy of the
 * configuration, and the gateway already knows which folder it confines uploads to — reading the
 * parameter would make the client the authority on what the credential may fetch, for no gain, since
 * a correct client can only ever name the folder the gateway told it about.
 *
 * @param context - The CMS services.
 * @returns Every image in the media folder on the published corpus.
 */
export async function listMedia(
  context: DecapContext,
): Promise<readonly ImplementationMediaFile[]> {
  const files = await context.media.listWithContent();
  return files.map(toMediaFile);
}

/**
 * Reads one image from a named branch, or the published corpus when none is named.
 *
 * @param context - The CMS services.
 * @param request - The path, and the branch to read it from.
 * @returns The image, base64 encoded.
 * @throws {CmsPolicyError} When the path is not a permitted image in the media folder.
 * @throws {DocumentMissingError} When the path is permitted but absent.
 */
export async function readMediaFile(
  context: DecapContext,
  request: { readonly path: string; readonly branch?: string | undefined },
): Promise<ImplementationMediaFile> {
  return toMediaFile(await context.media.read(request.path, request.branch));
}

/**
 * Reads an image belonging to a draft, from that draft's branch.
 *
 * This is what makes an uploaded image still visible after the author reloads the editor. Decap
 * works out which files a draft holds from the diffs `unpublished.ts` returns and then asks for each
 * non-page one here; reading it from the default branch instead would answer "not found" for every
 * image that has not been published yet.
 *
 * @param context - The CMS services.
 * @param request - The entry, and the path within it.
 * @returns The image, base64 encoded.
 */
export async function readUnpublishedMediaFile(
  context: DecapContext,
  request: EntryRef & { readonly path: string },
): Promise<ImplementationMediaFile> {
  const branch = branchForEntry(request, context.settings);
  return toMediaFile(await context.media.read(request.path, branch));
}

export interface DecapAsset {
  readonly path: string;
  readonly content: string;
  readonly encoding: 'base64';
}

/**
 * Checks the images a save carries and turns them into files for the commit (requirements.md R15).
 *
 * Every asset is checked before any of them is converted, and nothing here performs I/O, so a save
 * carrying one oversized image writes nothing at all — not the page, not the other images. That is
 * R3's "refused if **any** entry violates policy" applied to media, and it is the reason an author
 * gets one refusal to act on rather than a half-applied commit to unpick.
 *
 * Four things are checked, in the order that gives the most useful message first: the path (is this
 * a permitted image, in the media folder), the payload (is it base64 at all), the size, and finally
 * the leading bytes against the extension.
 *
 * @param assets - The assets Decap sent.
 * @param settings - The media folder and the size limit.
 * @returns The assets as draft files, ready to commit beside the page.
 * @throws {CmsPolicyError} When any asset's path or content is not permitted.
 * @throws {MediaTooLargeError} When any asset is over the limit.
 */
export function resolveAssets(
  assets: readonly DecapAsset[],
  settings: CmsSettings,
): readonly DraftFile[] {
  return assets.map((asset) => {
    const resolved = resolveMediaPath(asset.path, { folder: settings.mediaFolder });
    if (!resolved.ok) {
      throw new CmsPolicyError(resolved.reason, resolved.message);
    }

    const bytes = decodeBase64(resolved.path, asset.content);

    const tooLarge = checkMediaSize(bytes.length, {
      maxBytes: settings.maxUploadBytes,
      path: resolved.path,
    });
    if (tooLarge !== undefined) {
      throw new MediaTooLargeError(tooLarge);
    }

    const mismatch = checkMediaSignature(bytes.subarray(0, SIGNATURE_BYTES), resolved.path);
    if (mismatch !== undefined) {
      throw new CmsPolicyError(mismatch.reason, mismatch.message);
    }

    return { path: resolved.path, content: asset.content, encoding: 'base64' as const };
  });
}

/**
 * Decodes an asset's payload, refusing one that is not base64.
 *
 * `Buffer.from` is lenient — it discards whatever it cannot read and returns a short buffer rather
 * than failing — so the round trip is compared instead. Without that, a payload that was not base64
 * at all would be silently written as a truncated file, and the author would meet a broken image
 * rather than a refusal.
 */
function decodeBase64(path: string, content: string): Buffer {
  const bytes = Buffer.from(content, 'base64');
  const canonical = content.replace(/\s+/g, '').replace(/=+$/, '');

  if (bytes.toString('base64').replace(/=+$/, '') !== canonical) {
    throw new CmsPolicyError(
      'media-content-mismatch',
      `${path.slice(path.lastIndexOf('/') + 1)} did not arrive as a readable image. Try adding it again.`,
    );
  }

  return bytes;
}
