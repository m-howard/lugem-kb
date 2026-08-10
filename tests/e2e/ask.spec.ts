import { expect, test } from '@playwright/test';

/**
 * The ask flow, against the real gateway serving the real Docusaurus build.
 *
 * The thing worth proving here — and the thing no unit test can — is that a citation resolves to
 * a page the site genuinely has. A unit test only shows that the URL transformation matches the
 * rule someone wrote down; it cannot show the rule matches what Docusaurus actually emits.
 *
 * The stubbed model streams a fixed answer, and any question mentioning unicorns retrieves
 * nothing, so both response shapes are reachable without AWS.
 */

const COVERED_QUESTION = 'why bun workspaces?';
const UNCOVERED_QUESTION = 'what is our unicorn policy?';

test.describe('POST /v1/ask', () => {
  test('streams citations before any answer text', async ({ request }) => {
    const response = await request.post('/v1/ask', { data: { question: COVERED_QUESTION } });

    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/event-stream');

    const body = await response.text();
    expect(body).toContain('event: citations');
    expect(body).toContain('event: token');
    expect(body.indexOf('event: citations')).toBeLessThan(body.indexOf('event: token'));
  });

  // No stream, no model call, and the same body /v1/search returns. Declining has to stay cheap.
  test('answers with plain JSON when nothing covers the question', async ({ request }) => {
    const response = await request.post('/v1/ask', { data: { question: UNCOVERED_QUESTION } });

    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('application/json');
    expect(await response.json()).toEqual({
      covered: false,
      message: 'No documentation covers this question.',
    });
  });

  test('refuses a GET, so a question cannot land in an access log', async ({ request }) => {
    const response = await request.get('/v1/ask?question=sensitive');

    expect(response.status()).not.toBe(200);
  });
});

test.describe('the ask widget', () => {
  test('answers a question from any documentation page', async ({ page }) => {
    await page.goto('/adr/0001-bun-workspace-monorepo');
    await page.getByRole('button', { name: 'Ask the docs' }).click();

    const panel = page.getByRole('dialog', { name: 'Ask the documentation' });
    await expect(panel).toBeVisible();

    await panel.getByLabel('Your question').fill(COVERED_QUESTION);
    await panel.getByRole('button', { name: 'Ask', exact: true }).click();

    await expect(panel.getByText('existing VPC')).toBeVisible();
    await expect(panel.getByText('Sources')).toBeVisible();
  });

  // R23's reader half, end to end. The unit tests cover the state machine and the route; this is
  // the seam between them — that the id from the citations frame survives into the POST.
  test('reports an unhelpful answer, and says so once it lands', async ({ page }) => {
    await page.goto('/adr/0001-bun-workspace-monorepo');
    await page.getByRole('button', { name: 'Ask the docs' }).click();

    const panel = page.getByRole('dialog', { name: 'Ask the documentation' });
    await panel.getByLabel('Your question').fill(COVERED_QUESTION);
    await panel.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(panel.getByText('existing VPC')).toBeVisible();

    const posted = page.waitForRequest(
      (request) => request.url().endsWith('/v1/feedback') && request.method() === 'POST',
    );

    await panel.getByRole('button', { name: 'This did not help' }).click();
    await panel
      .getByLabel('What were you looking for? (optional)')
      .fill('It answered the wrong thing.');
    await panel.getByRole('button', { name: 'Send' }).click();

    const request = await posted;
    expect(request.postDataJSON()).toMatchObject({
      question: COVERED_QUESTION,
      reason: 'It answered the wrong thing.',
    });

    await expect(panel.getByText('Thanks — we have recorded this gap.')).toBeVisible();
  });

  // Nothing to rate when there was no answer, and the gap is already recorded server-side.
  test('offers no feedback control when nothing covered the question', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Ask the docs' }).click();

    const panel = page.getByRole('dialog', { name: 'Ask the documentation' });
    await panel.getByLabel('Your question').fill(UNCOVERED_QUESTION);
    await panel.getByRole('button', { name: 'Ask', exact: true }).click();

    await expect(panel.getByText('No documentation covers this question.')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'This did not help' })).toHaveCount(0);
  });

  // The citation is only evidence if the reader can reach it. This is the assertion that catches
  // a source-URI-to-route mapping that drifts away from what the site actually builds.
  test('a citation links to a page the site really has', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Ask the docs' }).click();

    const panel = page.getByRole('dialog', { name: 'Ask the documentation' });
    await panel.getByLabel('Your question').fill(COVERED_QUESTION);
    await panel.getByRole('button', { name: 'Ask', exact: true }).click();

    const citation = panel.getByRole('link', { name: /0001-bun-workspace-monorepo/ });
    await expect(citation).toBeVisible();

    await citation.click();
    await expect(page).toHaveURL(/\/adr\/0001-bun-workspace-monorepo$/);
    await expect(page.locator('h1').first()).toBeVisible();
  });

  // The no-coverage state must not read as an answer. It has no Sources block, which is the
  // visible half of the API giving that case its own response shape.
  test('says plainly when nothing covers the question, with no sources', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Ask the docs' }).click();

    const panel = page.getByRole('dialog', { name: 'Ask the documentation' });
    await panel.getByLabel('Your question').fill(UNCOVERED_QUESTION);
    await panel.getByRole('button', { name: 'Ask', exact: true }).click();

    // Scoped to the transcript. The same sentence also reaches the visually hidden status region,
    // which is how a screen reader hears it — asserting on both at once is a strict-mode clash.
    const transcript = panel.getByRole('log');
    await expect(transcript.getByText('No documentation covers this question.')).toBeVisible();
    await expect(transcript.getByText('Sources')).toBeHidden();
  });

  test('announces the outcome once, for a screen reader', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Ask the docs' }).click();

    const panel = page.getByRole('dialog', { name: 'Ask the documentation' });
    await panel.getByLabel('Your question').fill(COVERED_QUESTION);
    await panel.getByRole('button', { name: 'Ask', exact: true }).click();

    await expect(panel.getByRole('status')).toHaveText(/Answer ready, with 1 source/);
  });

  // Escape closing without returning focus strands a keyboard user on the page body.
  test('closes on Escape and returns focus to the launcher', async ({ page }) => {
    await page.goto('/');
    const launcher = page.getByRole('button', { name: 'Ask the docs' });
    await launcher.click();

    await expect(page.getByRole('dialog', { name: 'Ask the documentation' })).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.getByRole('dialog', { name: 'Ask the documentation' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Ask the docs' })).toBeFocused();
  });

  test('survives navigating to a cited page, keeping the conversation', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Ask the docs' }).click();

    const panel = page.getByRole('dialog', { name: 'Ask the documentation' });
    await panel.getByLabel('Your question').fill(COVERED_QUESTION);
    await panel.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(panel.getByText('Sources')).toBeVisible();

    await panel.getByRole('link', { name: /0001-bun-workspace-monorepo/ }).click();
    await expect(page).toHaveURL(/\/adr\/0001-bun-workspace-monorepo$/);

    // Root sits above the theme layout and is not remounted by client-side navigation, so the
    // panel and its transcript are still there.
    await expect(panel.getByText(COVERED_QUESTION)).toBeVisible();
  });
});

test.describe('the ask page', () => {
  test('is reachable from the navbar and answers a question', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Ask', exact: true }).first().click();

    await expect(page).toHaveURL(/\/ask$/);
    await expect(page.getByRole('heading', { name: 'Ask the documentation' })).toBeVisible();

    await page.getByLabel('Your question').fill(COVERED_QUESTION);
    await page.getByRole('button', { name: 'Ask', exact: true }).click();

    await expect(page.getByText('existing VPC')).toBeVisible();
  });
});
