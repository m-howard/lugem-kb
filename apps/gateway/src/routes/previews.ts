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

/**
 * A preview is code, not just prose — and it is code nobody has reviewed yet.
 *
 * `docs/**` is MDX, so a page compiles to a React component: an author can put script in a pull
 * request as easily as a paragraph, and the CMS lets someone with no git account open one
 * (see ADR 0014). Those bytes are served from the origin that also carries `/admin`, the CMS API
 * and the reader session, so without this header opening a preview runs unreviewed script with
 * the privileges of the person reading it — a sign-in token copied into the tab's `sessionStorage`
 * in bearer mode, a credentialed call to the editorial API in ALB mode. `x-robots-tag` says
 * nothing about any of that; it speaks to crawlers.
 *
 * `sandbox` without `allow-same-origin` drops the document into an opaque origin: no storage, no
 * cookies, no same-origin reads, and no credentials on anything it fetches. `allow-scripts` stays
 * because a preview has to render like the real site — Docusaurus hydrates, routes client-side and
 * styles itself, and all of that still works from an opaque origin (verified against a real build
 * in Chromium). `allow-popups` is here so a `target="_blank"` link is not a dead click; it is not
 * paired with `allow-popups-to-escape-sandbox`, so what it opens stays sandboxed too.
 */
const CONTENT_SECURITY_POLICY = 'sandbox allow-scripts allow-popups';

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

  // On the way out rather than per response, so every answer this sub-app can produce carries the
  // sandbox — the served page, the build's own 404, a refusal, and anything added here later.
  // A response that forgot it would be the one that matters.
  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('cache-control', CACHE_CONTROL);
    c.res.headers.set('content-security-policy', CONTENT_SECURITY_POLICY);
    // Unreviewed content on the same host as the published site. Even on an internal deployment a
    // crawler may run, and a draft page outranking the real one is a support ticket.
    c.res.headers.set('x-robots-tag', 'noindex, nofollow');
  });

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
      });
    }

    // The build's own 404 page, so a mistyped route inside a live preview still looks like the
    // site. Its absence means the whole preview is gone — merged, closed, or never published.
    const notFoundPage = await options.client.getFirst([resolved.notFoundKey]);
    if (notFoundPage !== undefined) {
      return c.body(new Uint8Array(notFoundPage.body), NOT_FOUND, {
        'content-type': HTML_CONTENT_TYPE,
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
