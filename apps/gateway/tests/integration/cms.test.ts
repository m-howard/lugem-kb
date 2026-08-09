import { describe, expect, it } from 'vitest';

import { buildCmsTestApp, buildTestApp, TEST_REPOSITORY } from '../helpers/build-test-app';
import { type FakeGitHubRoute } from '../helpers/fake-github';

const REPO = `/repos/${TEST_REPOSITORY}`;
const BASE_COMMIT = 'commit-main';
const BASE_TREE = 'tree-main';

/** The reads every write path starts with: where `main` points, and what tree that commit has. */
const BASE_BRANCH_ROUTES: readonly FakeGitHubRoute[] = [
  { method: 'GET', path: `${REPO}/git/ref/heads/main`, respond: { object: { sha: BASE_COMMIT } } },
  {
    method: 'GET',
    path: `${REPO}/git/commits/${BASE_COMMIT}`,
    respond: { tree: { sha: BASE_TREE } },
  },
];

const WRITE_ROUTES: readonly FakeGitHubRoute[] = [
  ...BASE_BRANCH_ROUTES,
  {
    method: 'GET',
    path: /\/git\/ref\/heads\/cms\//,
    status: 404,
    respond: { message: 'Not Found' },
  },
  { method: 'POST', path: `${REPO}/git/blobs`, respond: { sha: 'blob-1' } },
  { method: 'POST', path: `${REPO}/git/trees`, respond: { sha: 'tree-2' } },
  { method: 'POST', path: `${REPO}/git/commits`, respond: { sha: 'commit-2' } },
  { method: 'POST', path: `${REPO}/git/refs`, respond: { ref: 'refs/heads/cms/pricing' } },
];

const DRAFT = { files: [{ path: 'docs/pricing.md', content: '# Pricing\n' }] };

describe('the editorial API', () => {
  // The CMS_REPOSITORY master switch. An unconfigured deployment has no editorial surface at all,
  // rather than one that answers 500 — and every existing deployment keeps working untouched.
  describe('when the CMS is switched off', () => {
    it('does not mount the editorial routes', async () => {
      const response = await buildTestApp().request('/v1/cms/config');

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: 'not_found' });
    });
  });

  // requirements.md R1. Each row is a way a request can fail to be attributed; all of them are
  // refused before any upstream call, which the fake proves by throwing on an unexpected one.
  describe('authentication (R1)', () => {
    it('refuses a request with no bearer token', async () => {
      const cms = await buildCmsTestApp();

      const response = await cms.app.request('/v1/cms/config');

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: 'unauthorized',
        reason: 'missing-credential',
      });
      expect(cms.host.calls).toEqual([]);
    });

    it.each([
      ['an expired token', { expiresInSeconds: -60 }, 'expired'],
      ['a token for another audience', { audience: 'other-app' }, 'wrong-audience'],
      ['a token from another issuer', { issuer: 'https://idp.evil/realm' }, 'untrusted-signer'],
    ])('refuses %s', async (_case, tokenOptions, reason) => {
      const cms = await buildCmsTestApp();
      const token = await cms.idp.sign({ sub: 'a1b2', email: 'sam@example.com' }, tokenOptions);

      const response = await cms.app.request('/v1/cms/config', {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ reason });
      expect(cms.host.calls).toEqual([]);
    });

    it('refuses a verified token that cannot be attributed to a person', async () => {
      const cms = await buildCmsTestApp();

      const response = await cms.app.request('/v1/cms/config', {
        headers: await cms.authorize({ sub: 'a1b2' }),
      });

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ reason: 'missing-email' });
    });

    it('admits an authenticated author', async () => {
      const cms = await buildCmsTestApp();

      const response = await cms.app.request('/v1/cms/config', { headers: await cms.authorize() });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        repository: TEST_REPOSITORY,
        defaultBranch: 'main',
        branchPrefix: 'cms/',
        permittedExtensions: ['.md', '.mdx'],
        allowMergeFromCms: false,
      });
    });

    // With one App credential, asking the git host who is calling returns the App. R6 needs the
    // human, so this is answered from the verified token and never proxied.
    it('reports the caller from the token, without asking the git host', async () => {
      const cms = await buildCmsTestApp();

      const response = await cms.app.request('/v1/cms/identity', {
        headers: await cms.authorize(),
      });

      expect(await response.json()).toEqual({
        subject: 'a1b2',
        email: 'sam@example.com',
        name: 'Sam Okoro',
      });
      expect(cms.host.calls).toEqual([]);
    });
  });

  // requirements.md R3. Refusal happens before the upstream call, so a policy failure can never
  // partially apply — asserted by the git host recording no calls at all.
  describe('write confinement (R3)', () => {
    const cases: readonly [string, string, string][] = [
      ['a workflow file', '.github/workflows/ci.yml', 'extension'],
      ['a markdown file outside the docs tree', '.github/workflows/evil.md', 'outside-prefixes'],
      ['the repository root', 'README.md', 'outside-prefixes'],
      ['traversal out of the docs tree', 'docs/../.github/workflows/ci.md', 'traversal'],
      ['a shell script inside the docs tree', 'docs/deploy.sh', 'extension'],
      ['a null byte', 'docs/index\0.md', 'null-byte'],
    ];

    it.each(cases)(
      'refuses %s with 403 and makes no upstream call',
      async (_case, path, reason) => {
        const cms = await buildCmsTestApp();

        const response = await cms.app.request('/v1/cms/drafts/cms/pricing', {
          method: 'PUT',
          headers: { ...(await cms.authorize()), 'content-type': 'application/json' },
          body: JSON.stringify({ files: [{ path, content: 'x' }] }),
        });

        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: 'forbidden', reason });
        expect(cms.host.calls).toEqual([]);
      },
    );

    // R3: "Multi-file tree writes are refused if any entry violates policy."
    it('refuses the whole change set when one entry is bad', async () => {
      const cms = await buildCmsTestApp({ routes: WRITE_ROUTES });

      const response = await cms.app.request('/v1/cms/drafts/cms/pricing', {
        method: 'PUT',
        headers: { ...(await cms.authorize()), 'content-type': 'application/json' },
        body: JSON.stringify({
          files: [
            { path: 'docs/fine.md', content: 'ok' },
            { path: '.github/workflows/ci.yml', content: 'evil' },
          ],
        }),
      });

      expect(response.status).toBe(403);
      expect(cms.host.calls).toEqual([]);
    });

    it('refuses a deletion outside the documentation prefixes', async () => {
      const cms = await buildCmsTestApp();

      const response = await cms.app.request('/v1/cms/drafts/cms/pricing', {
        method: 'PUT',
        headers: { ...(await cms.authorize()), 'content-type': 'application/json' },
        body: JSON.stringify({ deletions: ['.github/CODEOWNERS'] }),
      });

      expect(response.status).toBe(403);
      expect(cms.host.calls).toEqual([]);
    });
  });

  // requirements.md R4.
  describe('branch confinement (R4)', () => {
    it('creates a branch under the configured prefix', async () => {
      const cms = await buildCmsTestApp({ routes: WRITE_ROUTES });

      const response = await cms.app.request('/v1/cms/drafts/cms/pricing', {
        method: 'PUT',
        headers: { ...(await cms.authorize()), 'content-type': 'application/json' },
        body: JSON.stringify(DRAFT),
      });

      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ branch: 'cms/pricing', created: true });
    });

    it.each([
      ['creating', 'PUT', 'main'],
      ['deleting', 'DELETE', 'main'],
      ['writing outside the prefix', 'PUT', 'feature/pricing'],
      ['deleting outside the prefix', 'DELETE', 'release/2026-08'],
    ])('refuses %s', async (_case, method, branch) => {
      const cms = await buildCmsTestApp();

      const response = await cms.app.request(`/v1/cms/drafts/${branch}`, {
        method,
        headers: { ...(await cms.authorize()), 'content-type': 'application/json' },
        ...(method === 'PUT' ? { body: JSON.stringify(DRAFT) } : {}),
      });

      expect(response.status).toBe(403);
      expect(cms.host.calls).toEqual([]);
    });

    // R4: "Pull requests targeting anything other than the default branch are refused." The base
    // is taken from configuration, so there is no way to express one — asserted on the payload.
    it('always opens a pull request against the default branch', async () => {
      const cms = await buildCmsTestApp({
        routes: [{ method: 'POST', path: `${REPO}/pulls`, respond: { number: 7, state: 'open' } }],
      });

      await cms.app.request('/v1/cms/submissions', {
        method: 'POST',
        headers: { ...(await cms.authorize()), 'content-type': 'application/json' },
        body: JSON.stringify({
          branch: 'cms/pricing',
          title: 'Update pricing',
          base: 'production',
        }),
      });

      expect(cms.host.calls.at(-1)?.body).toMatchObject({ base: 'main', head: 'cms/pricing' });
    });
  });

  // requirements.md R6.
  describe('attribution (R6)', () => {
    it('commits as the human, with the app as committer and one trailer', async () => {
      const cms = await buildCmsTestApp({ routes: WRITE_ROUTES });

      await cms.app.request('/v1/cms/drafts/cms/pricing', {
        method: 'PUT',
        headers: { ...(await cms.authorize()), 'content-type': 'application/json' },
        body: JSON.stringify({ ...DRAFT, message: 'docs: rewrite pricing' }),
      });

      const commit = cms.host.calls.find((call) => call.path.endsWith('/git/commits'))?.body as {
        author?: unknown;
        committer?: unknown;
        message?: string;
      };

      expect(commit.author).toEqual({ name: 'Sam Okoro', email: 'sam@example.com' });
      expect(commit.committer).toBeUndefined();
      expect(
        commit.message?.split('\n').filter((line) => line.startsWith('Co-authored-by:')),
      ).toEqual(['Co-authored-by: Sam Okoro <sam@example.com>']);
    });

    it('discards an author the client tried to supply', async () => {
      const cms = await buildCmsTestApp({ routes: WRITE_ROUTES });

      await cms.app.request('/v1/cms/drafts/cms/pricing', {
        method: 'PUT',
        headers: { ...(await cms.authorize()), 'content-type': 'application/json' },
        body: JSON.stringify({
          ...DRAFT,
          author: { name: 'Someone Else', email: 'nope@example.com' },
        }),
      });

      const commit = cms.host.calls.find((call) => call.path.endsWith('/git/commits'))?.body as {
        author?: { email?: string };
      };

      expect(commit.author?.email).toBe('sam@example.com');
    });

    it('names the submitter and their email in the pull request body', async () => {
      const cms = await buildCmsTestApp({
        routes: [{ method: 'POST', path: `${REPO}/pulls`, respond: { number: 7, state: 'open' } }],
      });

      await cms.app.request('/v1/cms/submissions', {
        method: 'POST',
        headers: { ...(await cms.authorize()), 'content-type': 'application/json' },
        body: JSON.stringify({ branch: 'cms/pricing', title: 'Update pricing' }),
      });

      const body = (cms.host.calls.at(-1)?.body as { body?: string }).body ?? '';
      expect(body).toContain('Sam Okoro');
      expect(body).toContain('sam@example.com');
    });
  });

  // requirements.md R7: saving creates a branch, submitting creates a pull request, and the
  // gateway refuses merges by default.
  describe('the editorial workflow (R7)', () => {
    it('saving a draft does not open a pull request', async () => {
      const cms = await buildCmsTestApp({ routes: WRITE_ROUTES });

      await cms.app.request('/v1/cms/drafts/cms/pricing', {
        method: 'PUT',
        headers: { ...(await cms.authorize()), 'content-type': 'application/json' },
        body: JSON.stringify(DRAFT),
      });

      expect(cms.host.paths().some((path) => path.endsWith('/pulls'))).toBe(false);
    });

    it('moves an existing draft branch rather than recreating it', async () => {
      const cms = await buildCmsTestApp({
        routes: [
          {
            method: 'GET',
            path: `${REPO}/git/ref/heads/cms/pricing`,
            respond: { object: { sha: 'commit-draft' } },
          },
          {
            method: 'GET',
            path: `${REPO}/git/commits/commit-draft`,
            respond: { tree: { sha: 'tree-draft' } },
          },
          { method: 'POST', path: `${REPO}/git/blobs`, respond: { sha: 'blob-1' } },
          { method: 'POST', path: `${REPO}/git/trees`, respond: { sha: 'tree-2' } },
          { method: 'POST', path: `${REPO}/git/commits`, respond: { sha: 'commit-2' } },
          { method: 'PATCH', path: `${REPO}/git/refs/heads/cms/pricing`, respond: {} },
        ],
      });

      const response = await cms.app.request('/v1/cms/drafts/cms/pricing', {
        method: 'PUT',
        headers: { ...(await cms.authorize()), 'content-type': 'application/json' },
        body: JSON.stringify(DRAFT),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ created: false });
      // Built on the draft's own tip, not on main — otherwise every save would drop the last one.
      const commit = cms.host.calls.find((call) => call.path.endsWith('/git/commits'))?.body as {
        parents?: string[];
      };
      expect(commit.parents).toEqual(['commit-draft']);
    });

    it('discards a draft by deleting its branch', async () => {
      const cms = await buildCmsTestApp({
        routes: [
          {
            method: 'DELETE',
            path: `${REPO}/git/refs/heads/cms/pricing`,
            status: 204,
            respond: {},
          },
        ],
      });

      const response = await cms.app.request('/v1/cms/drafts/cms/pricing', {
        method: 'DELETE',
        headers: await cms.authorize(),
      });

      expect(response.status).toBe(204);
      expect(cms.host.paths()).toEqual([`${REPO}/git/refs/heads/cms/pricing`]);
    });

    it('lists submissions for one draft branch', async () => {
      const cms = await buildCmsTestApp({
        routes: [
          {
            method: 'GET',
            path: `${REPO}/pulls`,
            respond: [
              { number: 7, state: 'open', title: 'Update pricing', head: { ref: 'cms/pricing' } },
            ],
          },
        ],
      });

      const response = await cms.app.request('/v1/cms/submissions?branch=cms/pricing', {
        headers: await cms.authorize(),
      });

      expect(await response.json()).toMatchObject({ submissions: [{ number: 7 }] });
      // Scoped to this repository's owner, so another fork's branch cannot be listed by name.
      expect(cms.host.paths()[0]).toContain('head=acme%3Acms%2Fpricing');
    });

    it('reports where a submission got to', async () => {
      const cms = await buildCmsTestApp({
        routes: [
          {
            method: 'GET',
            path: `${REPO}/pulls/7`,
            respond: {
              number: 7,
              state: 'open',
              title: 'Update pricing',
              head: { ref: 'cms/pricing' },
              html_url: 'https://github.test/pulls/7',
            },
          },
        ],
      });

      const response = await cms.app.request('/v1/cms/submissions/7', {
        headers: await cms.authorize(),
      });

      expect(await response.json()).toMatchObject({
        number: 7,
        state: 'open',
        branch: 'cms/pricing',
      });
    });

    it('refuses a merge from the CMS by default', async () => {
      const cms = await buildCmsTestApp();

      const response = await cms.app.request('/v1/cms/submissions/7/merge', {
        method: 'POST',
        headers: await cms.authorize(),
      });

      expect(response.status).toBe(403);
      expect(cms.host.calls).toEqual([]);
    });

    it('permits a merge once the policy flag is set', async () => {
      const cms = await buildCmsTestApp({
        allowMergeFromCms: true,
        routes: [
          { method: 'PUT', path: `${REPO}/pulls/7/merge`, status: 200, respond: { merged: true } },
          { method: 'GET', path: `${REPO}/pulls/7`, respond: { number: 7, merged: true } },
        ],
      });

      const response = await cms.app.request('/v1/cms/submissions/7/merge', {
        method: 'POST',
        headers: await cms.authorize(),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ state: 'merged' });
    });
  });

  describe('reading the corpus through git', () => {
    const TREE_ROUTES: readonly FakeGitHubRoute[] = [
      ...BASE_BRANCH_ROUTES,
      {
        method: 'GET',
        path: `${REPO}/git/trees/${BASE_TREE}`,
        respond: {
          tree: [
            { path: 'docs/pricing.md', type: 'blob', sha: 'blob-pricing', size: 12 },
            { path: 'README.md', type: 'blob', sha: 'blob-readme', size: 4 },
            { path: '.github/workflows/ci.yml', type: 'blob', sha: 'blob-ci', size: 9 },
            { path: 'docs', type: 'tree', sha: 'tree-docs' },
          ],
        },
      },
    ];

    it('lists only documents the CMS may touch', async () => {
      const cms = await buildCmsTestApp({ routes: TREE_ROUTES });

      const response = await cms.app.request('/v1/cms/documents', {
        headers: await cms.authorize(),
      });

      expect(await response.json()).toEqual({
        documents: [{ path: 'docs/pricing.md', sha: 'blob-pricing', size: 12 }],
      });
    });

    it('reads a document and decodes it', async () => {
      const cms = await buildCmsTestApp({
        routes: [
          ...TREE_ROUTES,
          {
            method: 'GET',
            path: `${REPO}/git/blobs/blob-pricing`,
            respond: { content: Buffer.from('# Pricing\n').toString('base64'), encoding: 'base64' },
          },
        ],
      });

      const response = await cms.app.request('/v1/cms/documents/docs/pricing.md', {
        headers: await cms.authorize(),
      });

      expect(await response.json()).toMatchObject({
        path: 'docs/pricing.md',
        branch: 'main',
        content: '# Pricing\n',
      });
    });

    // A refusal and an absence are different signals to an operator reading the audit log, so
    // they get different statuses — the stance routes/documents.ts already takes.
    it('answers 404 for a permitted path that is not there', async () => {
      const cms = await buildCmsTestApp({ routes: TREE_ROUTES });

      const response = await cms.app.request('/v1/cms/documents/docs/missing.md', {
        headers: await cms.authorize(),
      });

      expect(response.status).toBe(404);
    });

    it('answers 403 for a path policy would never allow', async () => {
      const cms = await buildCmsTestApp();

      const response = await cms.app.request('/v1/cms/documents/README.md', {
        headers: await cms.authorize(),
      });

      expect(response.status).toBe(403);
      expect(cms.host.calls).toEqual([]);
    });
  });

  describe('when the git host refuses', () => {
    it('reports a conflict rather than a server error', async () => {
      const cms = await buildCmsTestApp({
        routes: [
          ...BASE_BRANCH_ROUTES,
          { method: 'GET', path: /\/git\/ref\/heads\/cms\//, status: 404, respond: {} },
          { method: 'POST', path: `${REPO}/git/blobs`, respond: { sha: 'blob-1' } },
          { method: 'POST', path: `${REPO}/git/trees`, respond: { sha: 'tree-2' } },
          { method: 'POST', path: `${REPO}/git/commits`, respond: { sha: 'commit-2' } },
          {
            method: 'POST',
            path: `${REPO}/git/refs`,
            status: 422,
            respond: { message: 'Reference already exists' },
          },
        ],
      });

      const response = await cms.app.request('/v1/cms/drafts/cms/pricing', {
        method: 'PUT',
        headers: { ...(await cms.authorize()), 'content-type': 'application/json' },
        body: JSON.stringify(DRAFT),
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'upstream_error' });
    });

    it('turns an upstream server error into a bad gateway, which the CMS may retry', async () => {
      const cms = await buildCmsTestApp({
        routes: [
          {
            method: 'GET',
            path: `${REPO}/git/ref/heads/main`,
            status: 500,
            respond: { message: 'boom' },
          },
        ],
      });

      const response = await cms.app.request('/v1/cms/documents', {
        headers: await cms.authorize(),
      });

      expect(response.status).toBe(502);
    });
  });

  it('rejects a malformed body before doing anything', async () => {
    const cms = await buildCmsTestApp();

    const response = await cms.app.request('/v1/cms/drafts/cms/pricing', {
      method: 'PUT',
      headers: { ...(await cms.authorize()), 'content-type': 'application/json' },
      body: JSON.stringify({ files: [{ path: '', content: 'x' }] }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
    expect(cms.host.calls).toEqual([]);
  });
});
