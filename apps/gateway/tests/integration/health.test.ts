import { describe, expect, it } from 'vitest';

import { buildCmsTestApp, buildTestApp } from '../helpers/build-test-app';

describe('health endpoints', () => {
  describe('GET /healthz', () => {
    it('reports ok', async () => {
      const response = await buildTestApp().request('/healthz');

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: 'ok' });
    });

    // R10: liveness must not depend on the git host or S3. If it did, an upstream outage would
    // fail every container's health check, ECS would cycle the whole service, and a dependency
    // blip would become an outage of our own making.
    it('stays ok when the corpus is unreachable', async () => {
      const response = await buildTestApp({ corpusUnreachable: true }).request('/healthz');

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: 'ok' });
    });
  });

  describe('GET /readyz', () => {
    it('reports ready when the corpus answers', async () => {
      const response = await buildTestApp().request('/readyz');

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: 'ready' });
    });

    // Readiness does depend on S3: a task that cannot read the corpus has nothing to serve and
    // should leave the target group until it can.
    it('reports 503 when the corpus is unreachable', async () => {
      const response = await buildTestApp({ corpusUnreachable: true }).request('/readyz');

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        status: 'not-ready',
        reason: 'corpus-unreachable',
      });
    });

    // R10: "Readiness fails until an installation token can be minted, so a miscredentialed task
    // never joins the target group." The stack creates the credential secret empty on purpose, so
    // this is the state every operator passes through — docs/corpus-repository.md says to expect it.
    describe('with the CMS switched on', () => {
      it('reports ready when a token can be minted', async () => {
        const cms = await buildCmsTestApp();

        const response = await cms.app.request('/readyz');

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ready' });
      });

      it('reports 503 when the credential is unusable', async () => {
        const cms = await buildCmsTestApp({ mintStatus: 401 });

        const response = await cms.app.request('/readyz');

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toEqual({
          status: 'not-ready',
          reason: 'cms-credential-unusable',
        });
      });

      // Liveness still must not depend on the git host, or a GitHub outage cycles every task.
      it('keeps liveness green when the credential is unusable', async () => {
        const cms = await buildCmsTestApp({ mintStatus: 401 });

        const response = await cms.app.request('/healthz');

        expect(response.status).toBe(200);
      });
    });
  });
});
