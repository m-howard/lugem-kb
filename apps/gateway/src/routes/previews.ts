import { Hono } from 'hono';

import { contentTypeFor, HTML_CONTENT_TYPE } from './content-types';
import { type AppEnv } from '../app-env';
import { type PreviewClient } from '../previews/preview-client';
import { resolvePreviewRequest } from '../previews/preview-key';

const OK = 200;
const BAD_REQUEST = 400;
const NOT_FOUND = 404;

/**
 * How long a browser may hold a preview asset.
 *
 * Short on purpose. A preview is republished on every push to the pull request, and an author who
 * pushed a fix and still sees the old page will conclude the preview is broken rather than cached.
 */
const CACHE_CONTROL = 'no-cache';

export interface PreviewRoutesOptions {
  readonly client: PreviewClient;
}

/**
 * Serves pull request previews (requirements.md R12).
 *
 * Mounted at `/previews`, behind whatever the load balancer already requires to reach the
 * documentation site — which is the reason previews live here rather than behind a CDN of their
 * own. A preview renders unmerged changes to a corpus that holds people and finance content, so it
 * belongs inside the same boundary as the published site, not on a public URL. See ADR 0018.
 *
 * Every path decision is made by `previews/preview-key.ts` before any S3 call, so this handler is
 * the thin part: ask for the candidates, serve the first that exists, fall back to the build's own
 * 404 page.
 *
 * @param options - `client` reads the preview bucket.
 * @returns A Hono app to mount at `/previews`.
 */
export function createPreviewRoutes(options: PreviewRoutesOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('*', async (c) => {
    const resolved = resolvePreviewRequest(c.req.path);

    if (!resolved.ok) {
      c.get('logger').warn({ reason: resolved.reason, path: c.req.path }, 'preview path refused');
      return c.text(resolved.message, BAD_REQUEST);
    }

    const found = await options.client.getFirst(resolved.keys);
    if (found !== undefined) {
      // Rewrapped for the same reason `routes/site.ts` does it: Hono's body accepts a
      // `Uint8Array<ArrayBuffer>`, and the SDK hands back the wider `ArrayBufferLike` view.
      return c.body(new Uint8Array(found.body), OK, {
        'content-type': contentTypeFor(found.key),
        'cache-control': CACHE_CONTROL,
        // A preview is unreviewed content on the same origin as the published site. Keeping it out
        // of search indexes matters even on an internal deployment, where a crawler may still run.
        'x-robots-tag': 'noindex, nofollow',
      });
    }

    // The build's own 404 page, so a mistyped route inside a live preview still looks like the
    // site. Its absence means the whole preview is gone — merged, closed, or never published.
    const notFoundPage = await options.client.getFirst([resolved.notFoundKey]);
    if (notFoundPage !== undefined) {
      return c.body(new Uint8Array(notFoundPage.body), NOT_FOUND, {
        'content-type': HTML_CONTENT_TYPE,
        'cache-control': CACHE_CONTROL,
        'x-robots-tag': 'noindex, nofollow',
      });
    }

    return c.text(
      `No preview for pull request ${resolved.pullNumber}. It may have been merged or closed, ` +
        'or its build may not have finished yet.',
      NOT_FOUND,
    );
  });

  return app;
}
