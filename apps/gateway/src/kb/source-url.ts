import { normalisePrefix, PERMITTED_EXTENSIONS } from './key-policy';

const S3_SCHEME = 's3://';

/**
 * Basenames Docusaurus resolves to their containing folder's route rather than a page of their
 * own. `docs/index.md` is the site root; `docs/adr/index.md` is `/adr`.
 */
const INDEX_BASENAMES = new Set(['index', 'readme']);

export interface CorpusLocation {
  readonly bucket: string;
  readonly prefix: string;
}

export interface ResolvedSource {
  /** Path relative to the corpus prefix, e.g. `adr/0005-x.md`. What `CorpusClient.get` accepts. */
  readonly path: string;
  /** Route on the published site, e.g. `/adr/0005-x`. */
  readonly url: string;
}

function hasPermittedExtension(key: string): boolean {
  return PERMITTED_EXTENSIONS.some((extension) => key.toLowerCase().endsWith(extension));
}

function toSiteUrl(path: string): string {
  const segments = path.slice(0, path.lastIndexOf('.')).split('/');
  if (INDEX_BASENAMES.has((segments.at(-1) ?? '').toLowerCase())) {
    segments.pop();
  }
  return `/${segments.join('/')}`;
}

/**
 * Turns a retrieval citation's `s3://` URI into the page a reader can open.
 *
 * Retrieval cites objects; readers follow links. Without this a citation reads
 * `s3://lugem-corpus/docs/adr/0006-deploy-into-an-existing-vpc.md`, which is checkable only by
 * someone with bucket access — so the citation stops being evidence for the reader it was for.
 *
 * The mapping is mechanical only because `apps/docs/docusaurus.config.ts` sets
 * `routeBasePath: '/'` and `numberPrefixParser: false`. The comment on the latter says that was
 * the point: an ADR is cited by its number, and these URLs are what citations resolve to. If
 * either setting changes, this function changes with it.
 *
 * Pure, total, and I/O-free, like `resolveDocumentKey`. A URI from another bucket, outside
 * the prefix, or without a markdown extension yields `undefined` rather than a guess — the caller
 * keeps the citation and renders it unlinked, because an uncitable link is worse than none.
 *
 * @param sourceUri - The `location.s3Location.uri` Bedrock returned.
 * @param location - The bucket and prefix the corpus actually lives at.
 * @returns The corpus-relative path and the site route, or `undefined` if the URI is not ours.
 *
 * @example
 * ```ts
 * resolveSourceUrl('s3://kb/docs/adr/0005-x.md', { bucket: 'kb', prefix: 'docs/' });
 * // → { path: 'adr/0005-x.md', url: '/adr/0005-x' }
 *
 * resolveSourceUrl('s3://kb/docs/index.md', { bucket: 'kb', prefix: 'docs/' });
 * // → { path: 'index.md', url: '/' }
 * ```
 */
export function resolveSourceUrl(
  sourceUri: string,
  location: CorpusLocation,
): ResolvedSource | undefined {
  const authority = `${S3_SCHEME}${location.bucket}/`;
  if (!sourceUri.startsWith(authority)) {
    return undefined;
  }

  const key = sourceUri.slice(authority.length);
  const prefix = normalisePrefix(location.prefix);
  // Compared as a directory boundary: `docs/` must not match `docs-internal/index.md`.
  if (!key.startsWith(prefix)) {
    return undefined;
  }

  const path = key.slice(prefix.length);
  if (path === '' || !hasPermittedExtension(path)) {
    return undefined;
  }

  return { path, url: toSiteUrl(path) };
}
