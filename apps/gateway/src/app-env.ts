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
    /**
     * When the request entered the app, for audit durations.
     *
     * Set once by the outermost middleware rather than per handler, so every record measures the
     * same thing — including the authentication work, which is the part most likely to be slow.
     */
    startedAt: number;
    /**
     * Which Decap action the request carries, once the proxy handler has parsed the body.
     *
     * Set on the context rather than returned, because the audit record has to name the action
     * even when the handler throws part-way through it — which is exactly the case an operator
     * most wants to read later.
     */
    decapAction?: string;
  };
}
