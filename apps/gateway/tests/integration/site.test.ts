import { describe, expect, it } from 'vitest';

import { buildTestApp } from '../helpers/build-test-app';

describe('static site handler', () => {
  describe('resolution', () => {
    it('serves the root index', async () => {
      const response = await buildTestApp().request('/');

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toContain('Lugem Knowledge Base');
    });

    // Docusaurus emits a directory per route with an index.html inside, and readers arrive with
    // both spellings — a trailing slash from in-site navigation, none from a pasted link.
    it.each([['/adr/'], ['/adr']])('resolves %s to the directory index', async (path) => {
      const response = await buildTestApp().request(path);

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toContain('Architecture decision records');
    });

    it('serves an asset with the right content type', async () => {
      const response = await buildTestApp().request('/assets/styles.css');

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/css');
    });

    it('serves the site 404 page for an unknown route', async () => {
      const response = await buildTestApp().request('/no-such-page');

      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('text/html');
      await expect(response.text()).resolves.toContain('Page not found');
    });

    it('falls back to plain text when the build has no 404 page', async () => {
      const response = await buildTestApp({
        siteRoot: 'apps/gateway/tests/fixtures/site/assets',
      }).request('/missing');

      expect(response.status).toBe(404);
      await expect(response.text()).resolves.toBe('Not found');
    });
  });

  // Serving files from disk by request path is a classic traversal sink. URL normalisation
  // removes the plain spellings before routing, but `%2f` is deliberately *not* decoded to a
  // separator by the URL parser, so an encoded separator does reach this handler — which is why
  // containment is checked on the resolved absolute path rather than on the raw string.
  describe('containment', () => {
    it.each([
      ['a literal parent traversal', '/../../package.json'],
      ['an encoded separator', '/%2e%2e%2fpackage.json'],
      ['a doubly encoded traversal', '/%2e%2e%2f%2e%2e%2fpackage.json'],
      ['an absolute-looking path', '//etc/passwd'],
    ])('never escapes the site root via %s', async (_case, path) => {
      const response = await buildTestApp().request(path);

      const body = await response.text();
      expect(body).not.toContain('"name": "lugem-kb"');
      expect(body).not.toContain('root:x:');
    });

    it('answers 404 rather than crashing on a null byte', async () => {
      const response = await buildTestApp().request('/index%00.html');

      expect(response.status).toBe(404);
    });

    it('answers 404 rather than crashing on malformed percent-encoding', async () => {
      const response = await buildTestApp().request('/%E0%A4%A');

      expect(response.status).toBe(404);
    });
  });
});
