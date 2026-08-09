import { type Logger } from 'pino';

import { type Identity } from './auth/claims';

/**
 * Hono context bindings shared by every route.
 *
 * The request logger is put on the context by middleware rather than imported as a module
 * singleton, so each request's logger can carry that request's id without global state.
 *
 * `identity` is set only by `createAuthMiddleware`, so it is present exactly on the routes that
 * require authentication. Reading it from an unauthenticated route is a programming error the
 * type system cannot catch here — Hono's variable map has no per-route narrowing — which is why
 * the CMS routes mount the middleware for the whole sub-app rather than per handler.
 */
export interface AppEnv {
  Variables: {
    logger: Logger;
    requestId: string;
    identity: Identity;
  };
}
