import { describe, expect, it } from 'vitest';

import { buildTestApp } from '../helpers/build-test-app';

/**
 * The static site is a catch-all, so it is mounted last in `createApp`. Getting that order
 * wrong is quiet and nasty: every API path would return the site's HTML with a 200 status, so
 * health checks stay green, the ALB keeps routing traffic, and only a client parsing JSON
 * notices. These tests are the guard.
 */
describe('route precedence', () => {
  const CORPUS = { 'docs/index.md': '# Welcome' };

  it('serves the site at the root', async () => {
    const response = await buildTestApp({ objects: CORPUS }).request('/');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    await expect(response.text()).resolves.toContain('Lugem Knowledge Base');
  });

  it.each([
    ['/healthz', 'application/json'],
    ['/readyz', 'application/json'],
    ['/v1/documents', 'application/json'],
    ['/v1/documents/index.md', 'application/json'],
  ])('answers %s with JSON, not the site', async (path, contentType) => {
    const response = await buildTestApp({ objects: CORPUS }).request(path);

    expect(response.headers.get('content-type')).toContain(contentType);
  });

  it('routes POST /v1/search to the API rather than the static handler', async () => {
    const response = await buildTestApp({
      objects: CORPUS,
      retrievalResults: [{ text: 'Answer.', uri: 's3://c/docs/a.md', score: 0.9 }],
    }).request('/v1/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'anything' }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toMatchObject({ covered: true });
  });

  it('serves a nested site route', async () => {
    const response = await buildTestApp({ objects: CORPUS }).request('/adr/');

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('Architecture decision records');
  });

  // A refused API path must return the API's 403, not the site's 404 page. Falling through to
  // the static handler would turn a policy decision into a missing-page message.
  it('keeps a refused document path on the API, not the site', async () => {
    const response = await buildTestApp({ objects: CORPUS }).request('/v1/documents/config.yaml');

    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('returns 404 for a path the site does not have', async () => {
    const response = await buildTestApp({ objects: CORPUS }).request('/no-such-page');

    expect(response.status).toBe(404);
  });
});
