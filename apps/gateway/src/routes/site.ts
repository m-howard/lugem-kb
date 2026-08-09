import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';

import { Hono } from 'hono';

import { type AppEnv } from '../app-env';

const OK = 200;
const NOT_FOUND = 404;
const INDEX_FILE = 'index.html';
const NOT_FOUND_FILE = '404.html';

/** Content types for what a Docusaurus build actually emits. Unknown extensions download rather than render. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
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

export interface SiteRoutesOptions {
  /** Directory holding the built Docusaurus output. */
  readonly root: string;
}

function contentTypeFor(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  const extension = dot === -1 ? '' : filePath.slice(dot).toLowerCase();
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

/**
 * Maps a URL path to a file inside the root, or `undefined` if it escapes.
 *
 * Serving files from disk by request path is a classic traversal sink, so containment is checked
 * on the resolved absolute path rather than on the string: `%2e%2e%2f` and `..` both normalise to
 * the same place, and only the resolved form catches both.
 */
function resolveWithinRoot(root: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }

  if (decoded.includes('\0')) {
    return undefined;
  }

  // URL paths always start with `/`; treat them as relative to the root, not to the filesystem.
  const relative = normalize(decoded.replace(/^\/+/, '')).replace(/^(\.\.(\/|\\|$))+/, '');
  if (isAbsolute(relative)) {
    return undefined;
  }

  const absoluteRoot = resolve(root);
  const candidate = resolve(join(absoluteRoot, relative));

  return candidate === absoluteRoot || candidate.startsWith(absoluteRoot + sep)
    ? candidate
    : undefined;
}

async function readIfFile(path: string): Promise<Buffer | undefined> {
  try {
    const stats = await stat(path);
    return stats.isFile() ? await readFile(path) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Locates the file backing a route.
 *
 * Docusaurus emits a directory per route with an `index.html` inside, so `/adr/0001` and
 * `/adr/0001/` must both resolve to the same file — readers and external links use each form
 * interchangeably.
 */
async function findSiteFile(root: string, urlPath: string): Promise<string | undefined> {
  const resolved = resolveWithinRoot(root, urlPath);
  if (resolved === undefined) {
    return undefined;
  }

  const candidates =
    urlPath.endsWith('/') || !urlPath.includes('.')
      ? [join(resolved, INDEX_FILE), resolved]
      : [resolved, join(resolved, INDEX_FILE)];

  for (const candidate of candidates) {
    const contents = await readIfFile(candidate);
    if (contents !== undefined) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Serves the built documentation site.
 *
 * Mounted last in {@link import('../app').createApp} so `/healthz` and `/v1/*` are matched first.
 * Getting that order wrong is quiet and nasty: a catch-all mounted early answers every API path
 * with the site's HTML and a 200 status, so health checks stay green and only a client parsing
 * JSON notices. `tests/integration/route-precedence.test.ts` guards it.
 *
 * Implemented over `node:fs` rather than `hono/bun`'s `serveStatic`: the Bun adapter touches the
 * `Bun` global at import time, which makes the whole app unimportable anywhere else — including
 * under the test runner. Nothing here needs a Bun-specific API.
 *
 * @param options - `root` is the built-site directory.
 * @returns A Hono app serving the static site.
 */
export function createSiteRoutes(options: SiteRoutesOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('*', async (c) => {
    const filePath = await findSiteFile(options.root, c.req.path);

    if (filePath === undefined) {
      const notFoundPage = await readIfFile(join(resolve(options.root), NOT_FOUND_FILE));
      return notFoundPage === undefined
        ? c.text('Not found', NOT_FOUND)
        : c.body(new Uint8Array(notFoundPage), NOT_FOUND, {
            'content-type': CONTENT_TYPES['.html'] ?? 'text/html',
          });
    }

    const contents = await readFile(filePath);
    return c.body(new Uint8Array(contents), OK, { 'content-type': contentTypeFor(filePath) });
  });

  return app;
}
