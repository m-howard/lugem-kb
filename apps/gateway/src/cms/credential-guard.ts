import { type MiddlewareHandler } from 'hono';

import { type AppEnv } from '../app-env';
import { recordAudit } from '../audit';
import { type InstallationTokenSource } from '../git/installation-token';

const SERVICE_UNAVAILABLE = 503;

export interface CredentialGuardOptions {
  readonly tokens: InstallationTokenSource;
}

/**
 * Refuses editorial requests while the git host credential is unusable (requirements.md R10).
 *
 * This is the check that actually keeps an unusable task from serving authors, and it lives here
 * rather than in the load balancer because **an ALB fails open**: when every target in a group is
 * unhealthy it routes to them anyway rather than returning 503. So a deployment whose App key was
 * never written has *no* healthy editorial targets — precisely the case the target group was meant
 * to catch — and the requests arrive regardless. The editorial target group still earns its place
 * by making ECS refuse to stabilise such a rollout, but it cannot be what turns traffic away.
 *
 * Mounted after authentication, so an anonymous caller still gets 401 rather than learning
 * anything about the credential's state.
 *
 * The cost is a cached lookup on the happy path: `token()` returns the cached installation token
 * until it is near expiry, so this adds no upstream call to a healthy request.
 *
 * @param options - The token source backing `/readyz`.
 * @returns Middleware answering 503 when no installation token can be obtained.
 */
export function createCredentialGuard(options: CredentialGuardOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    try {
      await options.tokens.checkCredential();
    } catch (error) {
      const identity = c.get('identity');
      recordAudit(c.get('logger'), {
        subject: identity.subject,
        email: identity.email,
        method: c.req.method,
        path: c.req.path,
        decision: 'error',
        reason: 'cms-credential-unusable',
        durationMs: Date.now() - c.get('startedAt'),
      });
      c.get('logger').error(
        { err: error instanceof Error ? error.message : String(error) },
        'the CMS credential is unusable',
      );

      return c.json(
        {
          error: 'not_ready',
          message:
            'The gateway cannot authenticate to the git host. Nothing you send will be saved ' +
            'until an operator fixes the credential.',
        },
        SERVICE_UNAVAILABLE,
      );
    }

    await next();
    return undefined;
  };
}
