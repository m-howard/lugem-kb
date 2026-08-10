/** Where the preview surface is mounted. One constant so the route and the policy cannot disagree. */
export const PREVIEW_MOUNT_PATH = '/previews';

/** `pr-42`. Bounded so a request cannot ask for a prefix megabytes long. */
const PULL_SEGMENT = /^pr-([1-9][0-9]{0,8})$/;

const INDEX_FILE = 'index.html';
const NOT_FOUND_FILE = '404.html';

/** Why a preview request was refused. Closed, so callers can branch and logs can be aggregated. */
export type PreviewPathViolation =
  | 'not-a-preview-path'
  | 'undecodable'
  | 'pull-number'
  | 'null-byte'
  | 'backslash'
  | 'empty-segment'
  | 'traversal';

export type ResolvedPreviewRequest =
  | {
      readonly ok: true;
      /** The pull request this preview belongs to, as it appeared in the path. */
      readonly pullNumber: string;
      /**
       * Keys to try, in order. Docusaurus emits a directory per route with an `index.html` inside,
       * so `/adr/0001` and `/adr/0001/` must both land on the same object — readers and citations
       * use each form interchangeably.
       */
      readonly keys: readonly string[];
      /** The build's own 404 page, so a missing route still looks like the site. */
      readonly notFoundKey: string;
    }
  | { readonly ok: false; readonly reason: PreviewPathViolation; readonly message: string };

function refuse(reason: PreviewPathViolation, message: string): ResolvedPreviewRequest {
  return { ok: false, reason, message };
}

/**
 * Turns a request path into the S3 keys that could satisfy it, or refuses it.
 *
 * Serving files from object storage by request path is the same traversal sink serving them from
 * disk is, minus the filesystem's own containment: S3 is a flat key space, so `pr-1/../../secrets`
 * is a perfectly valid key and nothing below this function would notice. Every refusal therefore
 * happens here, before any S3 call, and the function is pure and total — which is what lets the
 * whole table be asserted as a unit test. It mirrors `kb/key-policy.ts` deliberately; two path
 * policies that disagreed would be two chances to get containment wrong.
 *
 * Refusal precedes normalisation, for the reason spelled out there: collapsing `a/../b` into `b`
 * and then allowing it makes the policy's answer depend on a normaliser the caller cannot see.
 *
 * @param urlPath - The full request path, e.g. `/previews/pr-42/adr/0001/`.
 * @returns The keys to try, or the reason the request was refused.
 *
 * @example
 * ```ts
 * resolvePreviewRequest('/previews/pr-42/adr/0001/');
 * // → { ok: true, pullNumber: '42', keys: ['pr-42/adr/0001/index.html', 'pr-42/adr/0001'], ... }
 *
 * resolvePreviewRequest('/previews/pr-42/../../etc/passwd');
 * // → { ok: false, reason: 'traversal', ... }
 * ```
 */
export function resolvePreviewRequest(urlPath: string): ResolvedPreviewRequest {
  if (urlPath !== PREVIEW_MOUNT_PATH && !urlPath.startsWith(`${PREVIEW_MOUNT_PATH}/`)) {
    return refuse('not-a-preview-path', 'This is not a preview path.');
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.slice(PREVIEW_MOUNT_PATH.length));
  } catch {
    // `%2e%2e%2f` decodes to `../`; a malformed escape is refused rather than passed through raw,
    // because the raw form would then be compared against rules written for the decoded one.
    return refuse('undecodable', 'This preview path is not valid percent-encoding.');
  }

  if (decoded.includes('\0')) {
    return refuse('null-byte', 'This preview path contains a null byte.');
  }
  if (decoded.includes('\\')) {
    return refuse('backslash', 'This preview path contains a backslash.');
  }

  const trailingSlash = decoded.endsWith('/');
  const segments = decoded.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
  const pullSegment = segments[0] ?? '';
  const pullNumber = PULL_SEGMENT.exec(pullSegment)?.[1];

  if (pullNumber === undefined) {
    return refuse(
      'pull-number',
      `"${pullSegment}" does not name a pull request. Preview paths look like /previews/pr-42/.`,
    );
  }

  const rest = segments.slice(1);
  if (rest.some((segment) => segment === '')) {
    return refuse('empty-segment', 'This preview path contains an empty segment.');
  }
  if (rest.some((segment) => segment === '.' || segment === '..')) {
    return refuse('traversal', 'This preview path contains a relative traversal segment.');
  }

  const prefix = `pr-${pullNumber}/`;
  const notFoundKey = `${prefix}${NOT_FOUND_FILE}`;

  // The preview's own root. `pr-42/` is a key prefix, not an object, so there is only one
  // candidate — asking S3 for the prefix itself would always miss.
  if (rest.length === 0) {
    return { ok: true, pullNumber, keys: [`${prefix}${INDEX_FILE}`], notFoundKey };
  }

  const relative = rest.join('/');
  const asFile = `${prefix}${relative}`;
  const asDirectory = `${asFile}/${INDEX_FILE}`;

  // A path ending in a slash, or whose last segment has no extension, is a Docusaurus route rather
  // than an asset — try its directory index first. Otherwise try the object itself first. Both
  // orders try both, which is what makes `/adr/0001` and `/adr/0001/` equivalent.
  const directoryFirst = trailingSlash || !(rest.at(-1) ?? '').includes('.');

  return {
    ok: true,
    pullNumber,
    keys: directoryFirst ? [asDirectory, asFile] : [asFile, asDirectory],
    notFoundKey,
  };
}
