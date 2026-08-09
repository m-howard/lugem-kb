import { Hono } from 'hono';

import { type AppEnv } from '../app-env';
import { type InstallationTokenSource } from '../git/installation-token';
import { type CorpusClient } from '../kb/corpus-client';

const SERVICE_UNAVAILABLE = 503;

export interface HealthRoutesOptions {
  readonly corpus: CorpusClient;
  /** Absent when the CMS is switched off, and then readiness does not depend on the git host. */
  readonly tokens?: InstallationTokenSource | undefined;
}

interface ReadinessCheck {
  readonly reason: string;
  run(): Promise<unknown>;
}

/**
 * Liveness and readiness, deliberately split (requirements.md R10).
 *
 * `/healthz` touches nothing upstream. If it called S3, an S3 outage would fail liveness, ECS
 * would kill every task, and a dependency blip would become an outage of our own making.
 *
 * `/readyz` does depend on S3, because a task that cannot read the corpus has nothing to serve
 * and should leave the target group until it can. When the CMS is configured it also mints an
 * installation token, so a task that cannot authenticate to the git host never joins the target
 * group — which is what makes an empty credential secret a visible failure rather than a save
 * that breaks for the first author who tries one. `docs/corpus-repository.md` tells operators to
 * expect exactly this until they have written the PEM.
 *
 * @param options - The corpus client, and the token source when the CMS is on.
 * @returns A Hono app exposing `/healthz` and `/readyz`.
 */
export function createHealthRoutes(options: HealthRoutesOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const tokens = options.tokens;
  const checks: readonly ReadinessCheck[] = [
    { reason: 'corpus-unreachable', run: () => options.corpus.checkReachable() },
    ...(tokens === undefined
      ? []
      : [{ reason: 'cms-credential-unusable', run: () => tokens.checkCredential() }]),
  ];

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  app.get('/readyz', async (c) => {
    for (const check of checks) {
      try {
        await check.run();
      } catch (error) {
        c.get('logger').warn(
          { err: error instanceof Error ? error.message : String(error), reason: check.reason },
          'readiness check failed',
        );
        return c.json({ status: 'not-ready', reason: check.reason }, SERVICE_UNAVAILABLE);
      }
    }

    return c.json({ status: 'ready' });
  });

  return app;
}
