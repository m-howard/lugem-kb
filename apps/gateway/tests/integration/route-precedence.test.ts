import { describe, expect, it } from 'vitest';

import { buildCmsTestApp, buildTestApp } from '../helpers/build-test-app';

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

  // Two shapes to guard, because /v1/ask picks between them before the site handler could see
  // the path at all. A catch-all mounted too early would answer both with HTML and a 200.
  describe('POST /v1/ask reaches the API in both of its response shapes', () => {
    async function ask(retrievalResults: { text: string; uri: string; score: number }[]) {
      return buildTestApp({ objects: CORPUS, retrievalResults }).request('/v1/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'anything' }),
      });
    }

    it('streams when the corpus covers the question', async () => {
      const response = await ask([
        { text: 'Answer.', uri: 's3://test-corpus/docs/a.md', score: 0.9 },
      ]);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      await expect(response.text()).resolves.toContain('event: citations');
    });

    it('returns JSON when it does not', async () => {
      const response = await ask([]);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
      await expect(response.json()).resolves.toMatchObject({ covered: false });
    });

    it('does not let a GET fall through to the site and answer 200 with HTML', async () => {
      const response = await buildTestApp({ objects: CORPUS }).request('/v1/ask');

      expect(response.status).not.toBe(200);
    });
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

  // Without a terminator on `/v1`, an unknown API path falls through to the catch-all and answers
  // 200 with HTML — a JSON client sees a success it cannot parse, and a typo in a route looks
  // like a rendering bug. It also breaks R5's "an unmatched path is refused and logged".
  describe('the /v1 namespace is terminated before the site', () => {
    it.each([
      ['an unknown API path', '/v1/nonsense'],
      ['an unknown CMS path when the CMS is off', '/v1/cms/config'],
      ['a nested unknown path', '/v1/cms/drafts/cms/pricing/extra'],
    ])('answers %s with JSON 404', async (_case, path) => {
      const response = await buildTestApp({ objects: CORPUS }).request(path);

      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');
      await expect(response.json()).resolves.toMatchObject({ error: 'not_found' });
    });
  });

  it('keeps the CMS routes ahead of the terminator when it is switched on', async () => {
    const cms = await buildCmsTestApp();

    const response = await cms.app.request('/v1/cms/config', { headers: await cms.authorize() });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  // The one route that must not become JSON-only: the site still answers everything else.
  it('still serves the site when the CMS is mounted', async () => {
    const cms = await buildCmsTestApp();

    const response = await cms.app.request('/');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
  });
});
