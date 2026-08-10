import { describe, expect, it } from 'vitest';

import { buildTestApp } from '../helpers/build-test-app';

/**
 * The preview surface (requirements.md R12), driven through the real app.
 *
 * The unit tests in `src/previews/preview-key.test.ts` own the refusal table; this asserts that
 * the route is wired to it, that it reaches the preview bucket rather than the corpus one, and
 * that a deployment without previews is unchanged.
 */
describe('pull request previews', () => {
  const PREVIEW = {
    'pr-42/index.html': '<html><body>Preview of pull request 42</body></html>',
    'pr-42/adr/0001/index.html': '<html><body>ADR 0001, as changed</body></html>',
    'pr-42/assets/css/styles.css': 'body { color: rebeccapurple }',
    'pr-42/404.html': '<html><body>Page not found in this preview</body></html>',
  };

  function withPreviews() {
    return buildTestApp({ previewObjects: PREVIEW });
  }

  it('serves the preview root', async () => {
    const response = await withPreviews().request('/previews/pr-42/');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    await expect(response.text()).resolves.toContain('Preview of pull request 42');
  });

  it.each([['/previews/pr-42/adr/0001'], ['/previews/pr-42/adr/0001/']])(
    'resolves %s to the same page',
    async (path) => {
      const response = await withPreviews().request(path);

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toContain('ADR 0001, as changed');
    },
  );

  it('serves an asset with its own content type', async () => {
    const response = await withPreviews().request('/previews/pr-42/assets/css/styles.css');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/css');
  });

  // Unreviewed content on the same origin as the published site. Even on an internal deployment a
  // crawler may run, and a draft page outranking the real one is a support ticket.
  it('tells crawlers to stay away', async () => {
    const response = await withPreviews().request('/previews/pr-42/');

    expect(response.headers.get('x-robots-tag')).toContain('noindex');
  });

  // Republished on every push. A cached preview makes an author think their fix did not land.
  it('does not let a browser cache a preview', async () => {
    const response = await withPreviews().request('/previews/pr-42/');

    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  it("serves the preview's own 404 page for a route inside it that does not exist", async () => {
    const response = await withPreviews().request('/previews/pr-42/no-such-page');

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('text/html');
    await expect(response.text()).resolves.toContain('Page not found in this preview');
  });

  // The whole preview is gone — merged, closed, or never built. Say which, in a sentence.
  it('explains a pull request with no preview at all', async () => {
    const response = await withPreviews().request('/previews/pr-99/');

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toContain('merged or closed');
  });

  // The traversal that survives URL parsing. A plain `../..` is collapsed by the WHATWG URL
  // normaliser before any router sees it — see the test below — but an encoded slash is not, so
  // this is the form that actually reaches the route and the one the key policy has to refuse.
  it.each([
    ['an encoded traversal out of the prefix', '/previews/pr-42/..%2f..%2fetc%2fpasswd'],
    ['a doubly encoded traversal', '/previews/pr-42/%2e%2e%2f%2e%2e%2fetc%2fpasswd'],
    ['an escape into another pull request', '/previews/pr-42/adr%2f..%2f..%2fpr-99%2findex.html'],
    ['a branch name where a number belongs', '/previews/main/index.html'],
  ])('refuses %s', async (_case, path) => {
    const response = await withPreviews().request(path);

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).not.toContain('text/html');
  });

  it('never reaches the preview surface with a plain traversal, because the URL collapses first', async () => {
    const response = await withPreviews().request('/previews/pr-42/../../etc/passwd');

    // Normalised to `/etc/passwd`, so this is the site catch-all answering, not the preview route.
    expect(response.status).toBe(404);
    await expect(response.text()).resolves.not.toContain('Preview of pull request');
  });

  // A preview must never be able to read the corpus, and vice versa: they are different buckets
  // precisely so R21's "preview builds are never ingested" holds by construction.
  it('cannot reach the corpus bucket through a preview path', async () => {
    const response = await buildTestApp({
      objects: { 'docs/secret.md': '# Not for previews' },
      previewObjects: PREVIEW,
    }).request('/previews/pr-42/docs/secret.md');

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.not.toContain('Not for previews');
  });

  describe('when no preview bucket is configured', () => {
    it('leaves the path to the site catch-all', async () => {
      const response = await buildTestApp().request('/previews/pr-42/');

      expect(response.status).toBe(404);
      // The site's own 404 page, which is what every unknown path answered before R12 existed.
      await expect(response.text()).resolves.toContain('Page not found');
    });
  });
});
