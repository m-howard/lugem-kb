import { describe, expect, it } from 'vitest';

import { buildTestApp } from '../helpers/build-test-app';

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
  });
});
