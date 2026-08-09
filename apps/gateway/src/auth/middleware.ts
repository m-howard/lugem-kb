import { type MiddlewareHandler } from 'hono';

import { type IdentityVerifier } from './verifier';
import { type AppEnv } from '../app-env';
import { recordAudit } from '../audit';

const UNAUTHORIZED = 401;

export interface AuthMiddlewareOptions {
  readonly verifier: IdentityVerifier;
}

/**
 * Establishes the caller's identity, or refuses the request (requirements.md R1).
 *
 * A refusal answers 401 and makes **no upstream call** — the same order `routes/documents.ts`
 * uses for a refused path, and for the same reason: a request that was never going to be allowed
 * should not reach the git host, S3, or a model.
 *
 * The `reason` on the response is the closed-set refusal, not a message. An author whose provider
 * withholds the email claim and an author presenting a forged token both fail here, and telling
 * them apart from the audit log is the difference between a configuration fix and an incident.
 *
 * @param options - The verifier for the configured `AUTH_MODE`.
 * @returns Middleware setting `identity` on the context, or answering 401.
 */
export function createAuthMiddleware(options: AuthMiddlewareOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const startedAt = Date.now();
    const result = await options.verifier.verify((name) => c.req.header(name));

    if (!result.ok) {
      recordAudit(c.get('logger'), {
        subject: undefined,
        email: undefined,
        method: c.req.method,
        path: c.req.path,
        decision: 'unauthorized',
        reason: result.reason,
        durationMs: Date.now() - startedAt,
      });
      return c.json({ error: 'unauthorized', reason: result.reason }, UNAUTHORIZED);
    }

    c.set('identity', result.identity);
    await next();
    return undefined;
  };
}
