import { checkPathSyntax, type KeyPolicyViolation, normalisePrefix } from '../kb/key-policy';

/**
 * Image formats the media folder may hold (requirements.md R15).
 *
 * Two absences are decisions rather than omissions.
 *
 * **No `.svg`.** An SVG is a script carrier, and the site is served from the same origin as
 * `/admin` — where the author's access token lives in `sessionStorage`. An uploaded SVG would be
 * stored cross-site scripting against the editor itself, reachable by anyone who opens the page it
 * is on. A screenshot is worth having; a scripting surface on the editor's origin is not.
 *
 * **No `.avif`.** `routes/content-types.ts` has no entry for it, so the site would offer it as a
 * download rather than render it. An image the browser saves instead of showing is not an image.
 */
export const MEDIA_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'] as const;

/** Why an upload was refused. A closed set, so the audit log can be aggregated by it. */
export type MediaPolicyViolation =
  KeyPolicyViolation | 'media-extension' | 'media-outside-folder' | 'media-content-mismatch';

export type ResolvedMediaPath =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: MediaPolicyViolation; readonly message: string };

export interface MediaPolicyOptions {
  /** Repository folder uploads are confined to, e.g. `docs/assets/media/`. */
  readonly folder: string;
}

/**
 * A RIFF container names its type at byte 8; the four bytes before it are the file's own length.
 */
const RIFF_TYPE_OFFSET = 8;

/**
 * The leading bytes each permitted format starts with, from the formats' own specifications.
 *
 * Written as byte strings rather than numeric tables, and read back with the `latin1` encoding,
 * which maps one byte to one code unit. `'\x89PNG\r\n\x1a\n'` is the PNG signature as its
 * specification prints it, and reads as that at a glance — `[0x89, 0x50, 0x4e, ...]` does not.
 */
const SIGNATURES: readonly {
  readonly extensions: readonly string[];
  readonly leading: string;
  /** For containers whose type follows a length field rather than sitting at the start. */
  readonly atOffset?: { readonly offset: number; readonly value: string };
}[] = [
  { extensions: ['.png'], leading: '\x89PNG\r\n\x1a\n' },
  { extensions: ['.jpg', '.jpeg'], leading: '\xff\xd8\xff' },
  // Both GIF87a and GIF89a; the version digit after `GIF8` is not ours to care about.
  { extensions: ['.gif'], leading: 'GIF8' },
  {
    extensions: ['.webp'],
    leading: 'RIFF',
    atOffset: { offset: RIFF_TYPE_OFFSET, value: 'WEBP' },
  },
];

const BYTES_PER_MB = 1_000_000;
const BYTES_PER_KB = 1000;

/**
 * Renders a byte count the way an author would say it.
 *
 * Decimal rather than binary units, because the number appears in a sentence a person reads next to
 * a file their operating system also describes in MB. Being consistent with the file browser
 * matters more here than being consistent with the configuration variable.
 *
 * @param bytes - A byte count.
 * @returns A short human reading, e.g. `4.2 MB`.
 *
 * @example
 * ```ts
 * formatBytes(2_097_152); // → '2.1 MB'
 * ```
 */
export function formatBytes(bytes: number): string {
  if (bytes >= BYTES_PER_MB) {
    return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
  }
  if (bytes >= BYTES_PER_KB) {
    return `${Math.round(bytes / BYTES_PER_KB).toString()} kB`;
  }
  return `${bytes.toString()} bytes`;
}

/** The file name an author sees, from a repository path. */
export function mediaFileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function extensionOf(path: string): string {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf('.');
  return dot === -1 ? '' : lower.slice(dot);
}

/**
 * Resolves a repository path an author wants to upload to, or refuses it (requirements.md R3, R15).
 *
 * The syntactic rules are not restated here — they come from {@link checkPathSyntax}, which the
 * corpus path policy uses too. What this adds is the two rules that are specific to media: a
 * permitted image extension, and containment in the one configured folder. Confining uploads to a
 * single folder rather than to the documentation prefixes is deliberate: R3's prefixes say where
 * *pages* may be written, and an image is not a page. A narrower rule is also a rule an operator
 * can check by looking at one directory.
 *
 * @param requestedPath - Repository-relative path, as the editor supplied it.
 * @param options - The folder uploads are confined to.
 * @returns The accepted path, or the reason it was refused.
 *
 * @example
 * ```ts
 * resolveMediaPath('docs/assets/media/org-chart.png', { folder: 'docs/assets/media/' });
 * // → { ok: true, path: 'docs/assets/media/org-chart.png' }
 *
 * resolveMediaPath('docs/assets/media/notes.md', { folder: 'docs/assets/media/' });
 * // → { ok: false, reason: 'media-extension', ... }
 * ```
 */
export function resolveMediaPath(
  requestedPath: string,
  options: MediaPolicyOptions,
): ResolvedMediaPath {
  const syntax = checkPathSyntax(requestedPath);
  if (syntax !== undefined) {
    return { ok: false, reason: syntax.reason, message: syntax.message };
  }

  if (!MEDIA_EXTENSIONS.includes(extensionOf(requestedPath) as (typeof MEDIA_EXTENSIONS)[number])) {
    return {
      ok: false,
      reason: 'media-extension',
      message: `An image must be one of: ${MEDIA_EXTENSIONS.join(', ')}.`,
    };
  }

  // An empty folder would match every path, so it fails closed rather than granting the repository
  // — the same choice `path-policy.ts` makes about a blank prefix.
  const folder = normalisePrefix(options.folder);
  if (folder === '' || !requestedPath.startsWith(folder)) {
    return {
      ok: false,
      reason: 'media-outside-folder',
      message: `Images are stored in ${folder === '' ? '(no folder configured)' : folder}.`,
    };
  }

  return { ok: true, path: requestedPath };
}

/**
 * Checks an upload against the size limit (requirements.md R15).
 *
 * Separate from {@link resolveMediaPath} because the two are known at different moments: the path is
 * in the request, while the size is only known once the payload has been decoded. Both still run
 * before anything is written.
 *
 * @param bytes - Decoded size of the upload.
 * @param options - `maxBytes` is the configured limit; `path` names the file in the message.
 * @returns `undefined` when the upload fits, or the sentence to show the author.
 *
 * @example
 * ```ts
 * checkMediaSize(4_200_000, { maxBytes: 2_097_152, path: 'docs/assets/media/org-chart.png' });
 * // → 'org-chart.png is 4.2 MB, over the 2.1 MB limit for an image. ...'
 * ```
 */
export function checkMediaSize(
  bytes: number,
  options: { readonly maxBytes: number; readonly path: string },
): string | undefined {
  if (bytes <= options.maxBytes) {
    return undefined;
  }

  return (
    `${mediaFileName(options.path)} is ${formatBytes(bytes)}, over the ` +
    `${formatBytes(options.maxBytes)} limit for an image. Resize or compress it and add it again.`
  );
}

/**
 * Checks that an upload's bytes are the format its name claims.
 *
 * A `.png` holding HTML would be served from the documentation origin as `image/png` by
 * `routes/content-types.ts` — harmless in a browser, but it would make the media folder a general
 * file drop inside a repository whose whole point is that it contains only documentation. Reading
 * the first bytes is the cheapest way to keep the folder honest about what is in it.
 *
 * @param bytes - The decoded upload, or its first bytes.
 * @param path - The path it will be written to; only its extension is read.
 * @returns `undefined` when the bytes match, or the sentence to show the author.
 */
export function checkMediaSignature(
  bytes: Uint8Array,
  path: string,
): { readonly reason: MediaPolicyViolation; readonly message: string } | undefined {
  const extension = extensionOf(path);
  const signature = SIGNATURES.find((candidate) => candidate.extensions.includes(extension));
  if (signature === undefined) {
    return undefined;
  }

  const leading = Buffer.from(bytes).toString('latin1');
  const { offset, value } = signature.atOffset ?? { offset: 0, value: '' };

  if (leading.startsWith(signature.leading) && leading.startsWith(value, offset)) {
    return undefined;
  }

  return {
    reason: 'media-content-mismatch',
    message:
      `${mediaFileName(path)} is not ${extension.slice(1).toUpperCase()} data, whatever its name ` +
      'says. Export it again from whatever produced it.',
  };
}
