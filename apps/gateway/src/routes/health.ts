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
 * `/readyz` checks the corpus bucket, and the CMS credential when the CMS is configured — so an
 * unwritten App key is a visible, specific failure rather than a save that breaks for the first
 * author who tries one.
 *
 * **What `/readyz` does not do is keep a task out of the load balancer.** The target group probes
 * `/healthz` (see `gateway-ingress.ts`), so a task whose credential is unusable still receives
 * traffic and still serves readers perfectly well; only the editorial routes fail. That is the
 * deliberate trade. Pointing the target group here instead would satisfy R10's wording and mean a
 * GitHub or Secrets Manager blip drains every task and takes the public documentation site down
 * for readers who never needed the git host.
 *
 * So this is a **deploy-time and operator gate**, not a traffic gate: run
 * `scripts/check/verify-gateway.ts --wait-ready` after a deploy and fail the deploy on it.
 * `docs/deploying-to-aws.md` documents that as the step after `pulumi up`.
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
