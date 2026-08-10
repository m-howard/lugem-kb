import { Hono } from 'hono';

import { type AppEnv } from '../app-env';

/**
 * Who the gateway thinks the caller is.
 *
 * Small, and load-bearing for ALB mode. An ALB session cookie is only ever issued by a listener
 * rule whose action *authenticates*, and every other reader rule is set to `allow` so that an
 * expired session yields this service's JSON 401 rather than an HTML login page a `fetch` client
 * cannot parse. Without exactly one path that redirects, a browser arriving with no cookie would
 * be told 401 forever and given no way to fix it.
 *
 * `/v1/cms/identity` already does this job for editors, but it is mounted only when the CMS is
 * configured — a deployment that authenticates readers and runs no CMS needs its own.
 *
 * Mounted behind the reader auth middleware, so reaching the handler at all means the caller is
 * authenticated.
 *
 * @returns A Hono app exposing `GET /`.
 */
export function createIdentityRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/', (c) => c.json(c.get('identity')));

  return app;
}
