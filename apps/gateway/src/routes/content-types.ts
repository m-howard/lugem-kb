/**
 * Content types for what a Docusaurus build actually emits.
 *
 * Shared by the site catch-all and the preview surface, which serve the same build from different
 * places — one from the container's disk, one from object storage. Two copies of this table would
 * be two chances for a preview to download a stylesheet the live site renders.
 *
 * Unknown extensions download rather than render, which is the safe direction: a served file whose
 * type is guessed wrong is worse than one the browser offers to save.
 */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

export const HTML_CONTENT_TYPE = CONTENT_TYPES['.html'] ?? 'text/html; charset=utf-8';

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/**
 * The content type for a file path, by extension.
 *
 * @param filePath - A filesystem path or an S3 key; only what follows the last dot is read.
 * @returns The matching content type, or `application/octet-stream`.
 *
 * @example
 * ```ts
 * contentTypeFor('pr-42/assets/css/styles.css'); // → 'text/css; charset=utf-8'
 * ```
 */
export function contentTypeFor(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  const extension = dot === -1 ? '' : filePath.slice(dot).toLowerCase();
  return CONTENT_TYPES[extension] ?? DEFAULT_CONTENT_TYPE;
}
