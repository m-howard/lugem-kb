import { Hono } from 'hono';

import { type AppEnv } from '../app-env';
import { recordAudit } from '../audit';
import { type Identity } from '../auth/claims';

const NOT_FOUND = 404;

/**
 * Terminates the `/v1` namespace so an unknown API path cannot fall through to the site.
 *
 * The static site is a catch-all mounted last, which means that without this an unmatched
 * `/v1/cms/nope` answers **200 with HTML**. A JSON client sees a success it cannot parse, and a
 * typo in a CMS route looks like a rendering bug rather than a wrong URL.
 *
 * Mounted after every real `/v1` route and before the site, so route order carries the meaning —
 * `tests/integration/route-precedence.test.ts` is what keeps that true.
 *
 * The answer is 404 rather than 403, deliberately. R5's "an unmatched method/path combination is
 * refused with 403" is about the calls this service makes *at the git host*, and `endpoint-policy`
 * answers exactly that with a 403 and an audit record — see ADR 0014, which records where that
 * check moved to. Inbound, a path we have no route for is absent, not forbidden; 403 would assert
 * it exists and is being withheld, which is not true and tells a caller less.
 *
 * @returns A Hono app answering JSON 404 for anything under `/v1`.
 */
export function createApiNotFoundRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.all('*', (c) => {
    // This route sits outside the authenticated sub-app, so `identity` is present only when the
    // request already passed CMS authentication on its way here — which `AppEnv` cannot express.
    // An unauthenticated caller was already refused and recorded by the auth middleware; without
    // this record, the authenticated case would be the one request that produced no audit line
    // at all (requirements.md R9).
    const identity = c.get('identity') as Identity | undefined;

    recordAudit(c.get('logger'), {
      subject: identity?.subject,
      email: identity?.email,
      method: c.req.method,
      path: c.req.path,
      decision: 'refused',
      reason: 'no-such-route',
      durationMs: 0,
    });

    return c.json({ error: 'not_found', path: c.req.path }, NOT_FOUND);
  });

  return app;
}
