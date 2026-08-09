import { Hono } from 'hono';

import { type AppEnv } from '../app-env';
import { type CorpusClient } from '../kb/corpus-client';

const SERVICE_UNAVAILABLE = 503;

export interface HealthRoutesOptions {
  readonly corpus: CorpusClient;
}

/**
 * Liveness and readiness, deliberately split (requirements.md R10).
 *
 * `/healthz` touches nothing upstream. If it called S3, an S3 outage would fail liveness, ECS
 * would kill every task, and a dependency blip would become an outage of our own making.
 *
 * `/readyz` does depend on S3, because a task that cannot read the corpus has nothing to serve
 * and should leave the target group until it can.
 *
 * @param options - The corpus client used for the readiness probe.
 * @returns A Hono app exposing `/healthz` and `/readyz`.
 */
export function createHealthRoutes(options: HealthRoutesOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  app.get('/readyz', async (c) => {
    try {
      await options.corpus.checkReachable();
      return c.json({ status: 'ready' });
    } catch (error) {
      c.get('logger').warn(
        { err: error instanceof Error ? error.message : String(error) },
        'readiness check failed',
      );
      return c.json({ status: 'not-ready', reason: 'corpus-unreachable' }, SERVICE_UNAVAILABLE);
    }
  });

  return app;
}
