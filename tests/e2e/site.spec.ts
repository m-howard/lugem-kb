import { expect, test } from '@playwright/test';

/**
 * End-to-end against the real gateway serving the real Docusaurus build.
 *
 * Everything here is deliberately something the integration tests cannot prove: that the site
 * actually builds, that the built output is what the gateway serves, and that the API survives
 * being mounted behind a catch-all in a real process over a real socket.
 */

test.describe('documentation site', () => {
  test('renders the home page from the built site', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveTitle(/Lugem/);
    await expect(page.locator('nav').first()).toBeVisible();
  });

  test('navigates to a documentation page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Docs' }).first().click();

    await expect(page.locator('article, main').first()).toBeVisible();
  });

  test('serves an architecture decision record', async ({ page }) => {
    const response = await page.goto('/adr/0001-bun-workspace-monorepo');

    expect(response?.status()).toBe(200);
    await expect(page.locator('h1').first()).toBeVisible();
  });

  test('returns the site 404 page for an unknown route', async ({ page }) => {
    const response = await page.goto('/definitely-not-a-page');

    expect(response?.status()).toBe(404);
  });
});

test.describe('API behind the site', () => {
  test('answers the liveness probe', async ({ request }) => {
    const response = await request.get('/healthz');

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  // The failure this guards against is silent: a catch-all static handler mounted before the API
  // returns the site's HTML with a 200, so the load balancer keeps routing traffic and only a
  // client parsing JSON ever notices.
  test('serves JSON on the API paths, not the site', async ({ request }) => {
    const response = await request.get('/v1/documents');

    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('application/json');
    expect(await response.json()).toHaveProperty('documents');
  });

  test('answers a search with citations', async ({ request }) => {
    const response = await request.post('/v1/search', {
      data: { question: 'why bun workspaces?' },
    });

    expect(response.status()).toBe(200);
    const body = (await response.json()) as {
      covered: boolean;
      citations: { sourceUri: string }[];
    };
    expect(body.covered).toBe(true);
    expect(body.citations[0]?.sourceUri).toContain('adr/0001');
  });

  test('refuses a document path outside key policy', async ({ request }) => {
    const response = await request.get('/v1/documents/config.yaml');

    expect(response.status()).toBe(403);
  });
});
