import { expect, type Page, test } from '@playwright/test';

/**
 * End-to-end against the real gateway, the real Decap bundle, and a stub identity provider on the
 * same origin.
 *
 * This exists because the sign-in shim is the one part of the CMS that vitest cannot reach.
 * `pkce.ts` and `session.ts` are unit-tested, but nothing there proves the pieces fit: that the
 * page redirects to a provider, comes back with a code, exchanges it, and hands Decap a `fetch`
 * the gateway will actually accept. Each of those seams is a place a working unit can still be
 * wired up wrong — and two of them were, until this spec caught them.
 *
 * The editorial *operations* are asserted in `tests/integration/decap-proxy.test.ts`, where they
 * can be driven directly. Driving them through Decap's widgets here would test its UI more than
 * this repository's code, and would break on its next release.
 */

const SIGN_IN_TIMEOUT_MS = 30_000;

/**
 * Opens the editor: our OIDC sign-in, then Decap's own login button.
 *
 * The second step is Decap's, not ours. Its `proxy` backend renders an authentication page whose
 * button resolves immediately — there is no second credential — so an author who has already come
 * back from the identity provider still has one click to make. See `docs/editing-in-the-cms.md`.
 */
async function openEditor(page: Page): Promise<void> {
  await page.goto('/publisher/');
  await page.getByRole('button', { name: /login/i }).click({ timeout: SIGN_IN_TIMEOUT_MS });
}

test.describe('the documentation CMS at /publisher', () => {
  test('serves the editor shell', async ({ page }) => {
    const response = await page.goto('/publisher/');

    expect(response?.status()).toBe(200);
  });

  // The whole point: a browser with no token ends up with one, without anybody typing a URL.
  test('signs an author in and loads the editor', async ({ page }) => {
    await openEditor(page);

    await expect(page.getByText('Collections').first()).toBeVisible({
      timeout: SIGN_IN_TIMEOUT_MS,
    });
  });

  // Reaching the corpus at all proves the token was attached: `entriesByFolder` is refused
  // without one, so an unauthenticated editor would show an empty collection, not this page.
  test('lists the corpus the gateway serves', async ({ page }) => {
    await openEditor(page);

    await expect(page.getByText('Leave policy').first()).toBeVisible({
      timeout: SIGN_IN_TIMEOUT_MS,
    });
  });

  // The authorization code must not survive in the address bar: a reload would try to redeem it a
  // second time, and the provider would refuse.
  test('clears the authorization code from the address bar', async ({ page }) => {
    await openEditor(page);
    await expect(page.getByText('Collections').first()).toBeVisible({
      timeout: SIGN_IN_TIMEOUT_MS,
    });

    expect(new URL(page.url()).searchParams.has('code')).toBe(false);
  });

  test('reaches the adapter with a bearer token, never anonymously', async ({ page }) => {
    const unauthorised: string[] = [];
    page.on('request', (request) => {
      if (
        request.url().includes('/v1/cms/proxy') &&
        request.headers()['authorization'] === undefined
      ) {
        unauthorised.push(request.url());
      }
    });

    await openEditor(page);
    await expect(page.getByText('Leave policy').first()).toBeVisible({
      timeout: SIGN_IN_TIMEOUT_MS,
    });

    expect(unauthorised).toEqual([]);
  });
});

test.describe('the adapter behind the editor', () => {
  test('refuses an unauthenticated call, without reaching the git host', async ({ request }) => {
    const response = await request.post('/v1/cms/proxy', {
      data: { action: 'unpublishedEntries', params: {} },
    });

    expect(response.status()).toBe(401);
    expect(await response.json()).toMatchObject({ reason: 'missing-credential' });
  });

  // The sign-in parameters are public by nature and the page that needs them has no token yet.
  test('publishes the sign-in configuration anonymously', async ({ request }) => {
    const response = await request.get('/v1/publisher/config');

    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ authMode: 'bearer' });
  });

  // The site is a catch-all mounted last, so an unknown API path must still answer JSON rather
  // than the editor's HTML. Anonymously it is 401 rather than 404, which is the better answer: an
  // unauthenticated caller learns nothing about which editorial paths exist.
  test('answers an unknown editorial path with JSON, not the editor', async ({ request }) => {
    const response = await request.post('/v1/cms/nonsense');

    expect(response.status()).toBe(401);
    expect(response.headers()['content-type']).toContain('application/json');
  });
});
