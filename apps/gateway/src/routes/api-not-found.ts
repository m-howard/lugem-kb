import { Hono } from 'hono';

import { type AppEnv } from '../app-env';

const NOT_FOUND = 404;

/**
 * Terminates the `/v1` namespace so an unknown API path cannot fall through to the site.
 *
 * The static site is a catch-all mounted last, which means that without this an unmatched
 * `/v1/cms/nope` answers **200 with HTML**. A JSON client sees a success it cannot parse, and a
 * typo in a CMS route looks like a rendering bug rather than a wrong URL. It also matters for
 * requirements.md R5: "an unmatched method/path combination is refused and logged" is not true if
 * the answer is a page.
 *
 * Mounted after every real `/v1` route and before the site, so route order carries the meaning —
 * `tests/integration/route-precedence.test.ts` is what keeps that true.
 *
 * @returns A Hono app answering JSON 404 for anything under `/v1`.
 */
export function createApiNotFoundRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.all('*', (c) => c.json({ error: 'not_found', path: c.req.path }, NOT_FOUND));

  return app;
}
