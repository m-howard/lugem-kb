import { Hono } from 'hono';

import { type AppEnv } from '../app-env';
import { type AuthConfig } from '../config';

/** Scopes the publisher asks for. `openid` yields the subject; the rest carry R6's attribution. */
const SIGN_IN_SCOPES = 'openid profile email';

export interface PublisherConfigRoutesOptions {
  readonly auth: AuthConfig;
}

/**
 * What the `/publisher` page needs before it can sign anybody in.
 *
 * **Deliberately unauthenticated**, and it is worth being explicit about why that is safe. Every
 * field here is an OIDC *public client* parameter: the issuer, the client id, the audience and the
 * scopes all travel in the browser's own redirect URL, visible in the address bar and the history.
 * Serving them from here discloses nothing that signing in would not, and the alternative — an
 * authenticated discovery endpoint — cannot work, because a page with no token is exactly the page
 * that needs to know how to get one.
 *
 * It is mounted as its own sub-app rather than as a route under `/v1/cms`, so that "everything
 * under `/v1/cms` is authenticated" stays literally true and cannot be weakened by a later edit
 * that adds a route next to this one.
 *
 * In `alb` mode there is nothing for the browser to do: the load balancer issues a session cookie
 * at `/v1/cms/identity`, and the cookie travels on same-origin requests by itself. The mode is
 * reported so the page knows to redirect there instead of starting its own flow.
 *
 * @param options - The resolved auth configuration.
 * @returns A Hono app to mount at `/v1/publisher`.
 */
export function createPublisherConfigRoutes(options: PublisherConfigRoutesOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/config', (c) =>
    c.json(
      options.auth.mode === 'alb'
        ? { authMode: 'alb', signInPath: '/v1/cms/identity' }
        : {
            authMode: 'bearer',
            issuer: options.auth.issuer,
            clientId: options.auth.clientId,
            audience: options.auth.audience,
            scopes: SIGN_IN_SCOPES,
          },
    ),
  );

  return app;
}
