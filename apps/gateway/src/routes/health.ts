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
 * **`/readyz` gates editorial admission.** The load balancer has two target groups: the public one
 * probes `/healthz` and carries the site and the read APIs; the editorial one probes here and
 * carries `/v1/cms/*`. A task that cannot mint an installation token leaves the editorial group and
 * stays in the public one, so authors get a 503 from the load balancer while readers are entirely
 * unaffected — which is what R10 asks for without a git host outage taking the documentation site
 * down with it.
 *
 * It gates deploys as well: ECS waits for health in every attached target group, so a rollout
 * carrying an unwritten App key never stabilises and the circuit breaker rolls it back.
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
