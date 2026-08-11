import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';

import { Hono } from 'hono';

import { contentTypeFor, HTML_CONTENT_TYPE } from './content-types';
import { type AppEnv } from '../app-env';

const OK = 200;
const MOVED_PERMANENTLY = 301;
const NOT_FOUND = 404;
const INDEX_FILE = 'index.html';
const NOT_FOUND_FILE = '404.html';

export interface SiteRoutesOptions {
  /** Directory holding the built Docusaurus output. */
  readonly root: string;
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
 * Whether a slashless request path is really a directory whose index should answer it.
 *
 * The distinction the redirect turns on: `/adr` names a directory holding an `index.html`, while
 * `/assets/styles.css` names a file. Only the former is a route wearing the wrong spelling.
 */
async function isDirectoryRoute(root: string, urlPath: string): Promise<boolean> {
  if (urlPath === '/' || urlPath.endsWith('/')) {
    return false;
  }

  const resolved = resolveWithinRoot(root, urlPath);
  if (resolved === undefined || (await readIfFile(resolved)) !== undefined) {
    return false;
  }

  return (await readIfFile(join(resolved, INDEX_FILE))) !== undefined;
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
    // Before serving anything: a directory index answered at the slashless spelling loads, but
    // every relative URL inside it resolves one level too high. See `isDirectoryRoute`.
    if (await isDirectoryRoute(options.root, c.req.path)) {
      const { search } = new URL(c.req.url);
      return c.redirect(`${c.req.path}/${search}`, MOVED_PERMANENTLY);
    }

    const filePath = await findSiteFile(options.root, c.req.path);

    if (filePath === undefined) {
      const notFoundPage = await readIfFile(join(resolve(options.root), NOT_FOUND_FILE));
      return notFoundPage === undefined
        ? c.text('Not found', NOT_FOUND)
        : c.body(new Uint8Array(notFoundPage), NOT_FOUND, { 'content-type': HTML_CONTENT_TYPE });
    }

    const contents = await readFile(filePath);
    return c.body(new Uint8Array(contents), OK, { 'content-type': contentTypeFor(filePath) });
  });

  return app;
}
