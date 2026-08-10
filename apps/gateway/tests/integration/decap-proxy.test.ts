import { describe, expect, it } from 'vitest';

import {
  buildCmsTestApp,
  buildTestApp,
  TEST_MAX_UPLOAD_BYTES,
  TEST_MEDIA_FOLDER,
  TEST_REPOSITORY,
} from '../helpers/build-test-app';
import { type FakeGitHubRoute } from '../helpers/fake-github';

const REPO = `/repos/${TEST_REPOSITORY}`;
const PROXY = '/v1/cms/proxy';

const MAIN_COMMIT = 'commit-main';
const MAIN_TREE = 'tree-main';
const DRAFT_BRANCH = 'cms/guides/leave-policy';
const DRAFT_COMMIT = 'commit-draft';
const DRAFT_TREE = 'tree-draft';
const DRAFT_UPDATED_AT = '2026-08-10T09:00:00Z';
const MEDIA_FOLDER = TEST_MEDIA_FOLDER;
const ENTRY = { collection: 'guides', slug: 'leave-policy' };

/** A one-pixel PNG. Real image bytes, because the signature check reads them. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAd8s6BwAAAABJRU5ErkJggg==';

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** A base64 payload that decodes to more than the configured limit. */
function oversizedPng(): string {
  const png = Buffer.from(PNG_BASE64, 'base64');
  return Buffer.concat([png, Buffer.alloc(TEST_MAX_UPLOAD_BYTES, 0)]).toString('base64');
}

function blobRoute(sha: string, content: string): FakeGitHubRoute {
  return {
    method: 'GET',
    path: `${REPO}/git/blobs/${sha}`,
    respond: { content: base64(content), encoding: 'base64' },
  };
}

/** Where `main` points, and the corpus it holds. */
const MAIN_ROUTES: readonly FakeGitHubRoute[] = [
  { method: 'GET', path: `${REPO}/git/ref/heads/main`, respond: { object: { sha: MAIN_COMMIT } } },
  {
    method: 'GET',
    path: `${REPO}/git/commits/${MAIN_COMMIT}`,
    respond: { tree: { sha: MAIN_TREE } },
  },
  {
    method: 'GET',
    path: `${REPO}/git/trees/${MAIN_TREE}`,
    respond: {
      tree: [
        { path: 'docs/index.md', type: 'blob', sha: 'blob-index', size: 9 },
        { path: 'docs/guides/leave-policy.md', type: 'blob', sha: 'blob-leave', size: 8 },
        { path: 'docs/guides/deep/nested.md', type: 'blob', sha: 'blob-nested', size: 8 },
        // Neither of these may reach an editor: one is outside the docs prefix, the other is not
        // markdown. Both are dropped by the path policy the adapter shares with the REST routes.
        { path: '.github/workflows/ci.yml', type: 'blob', sha: 'blob-ci', size: 4 },
        // An image outside the media folder. Not a page, and not the media library's either.
        { path: 'docs/logo.png', type: 'blob', sha: 'blob-logo', size: 4 },
        // The media folder, holding the one published image.
        { path: `${MEDIA_FOLDER}org-chart.png`, type: 'blob', sha: 'blob-chart', size: 68 },
      ],
    },
  },
  blobRoute('blob-index', '# Index\n'),
  blobRoute('blob-leave', '# Leave\n'),
  blobRoute('blob-nested', '# Deep\n'),
  {
    method: 'GET',
    path: `${REPO}/git/blobs/blob-chart`,
    respond: { content: PNG_BASE64, encoding: 'base64' },
  },
];

/** A draft branch that changes one page and adds another. */
const DRAFT_ROUTES: readonly FakeGitHubRoute[] = [
  {
    method: 'GET',
    path: `${REPO}/git/ref/heads/${DRAFT_BRANCH}`,
    respond: { object: { sha: DRAFT_COMMIT } },
  },
  {
    method: 'GET',
    path: `${REPO}/git/commits/${DRAFT_COMMIT}`,
    respond: { tree: { sha: DRAFT_TREE }, committer: { date: DRAFT_UPDATED_AT } },
  },
  {
    method: 'GET',
    path: `${REPO}/git/trees/${DRAFT_TREE}`,
    respond: {
      tree: [
        { path: 'docs/index.md', type: 'blob', sha: 'blob-index', size: 9 },
        { path: 'docs/guides/leave-policy.md', type: 'blob', sha: 'blob-leave-2', size: 12 },
        { path: 'docs/guides/new-page.md', type: 'blob', sha: 'blob-new', size: 6 },
        // An image the author uploaded to this draft, not yet published — requirements.md R15.
        { path: `${MEDIA_FOLDER}new-chart.png`, type: 'blob', sha: 'blob-new-chart', size: 68 },
      ],
    },
  },
  blobRoute('blob-leave-2', '# Leave v2\n'),
  blobRoute('blob-new', '# New\n'),
  {
    method: 'GET',
    path: `${REPO}/git/blobs/blob-new-chart`,
    respond: { content: PNG_BASE64, encoding: 'base64' },
  },
];

const MATCHING_REFS: FakeGitHubRoute = {
  method: 'GET',
  path: `${REPO}/git/matching-refs/heads/cms/`,
  respond: [{ ref: `refs/heads/${DRAFT_BRANCH}` }],
};

function pullsRoute(respond: unknown): FakeGitHubRoute {
  return { method: 'GET', path: `${REPO}/pulls`, respond };
}

const OPEN_PULL = {
  number: 42,
  title: 'docs: update leave-policy',
  state: 'open',
  html_url: 'https://github.test/acme/handbook/pull/42',
  head: { ref: DRAFT_BRANCH, repo: { full_name: TEST_REPOSITORY } },
  base: { ref: 'main' },
};

/** The reads and writes a draft save performs when the branch does not exist yet. */
const SAVE_ROUTES: readonly FakeGitHubRoute[] = [
  { method: 'GET', path: `${REPO}/git/ref/heads/main`, respond: { object: { sha: MAIN_COMMIT } } },
  {
    method: 'GET',
    path: `${REPO}/git/commits/${MAIN_COMMIT}`,
    respond: { tree: { sha: MAIN_TREE } },
  },
  {
    method: 'GET',
    path: /\/git\/ref\/heads\/cms\//,
    status: 404,
    respond: { message: 'Not Found' },
  },
  { method: 'POST', path: `${REPO}/git/blobs`, respond: { sha: 'blob-written' } },
  { method: 'POST', path: `${REPO}/git/trees`, respond: { sha: 'tree-written' } },
  { method: 'POST', path: `${REPO}/git/commits`, respond: { sha: 'commit-written' } },
  { method: 'POST', path: `${REPO}/git/refs`, respond: { ref: `refs/heads/${DRAFT_BRANCH}` } },
];

interface ProxyCallOptions {
  readonly routes?: readonly FakeGitHubRoute[];
  readonly allowMergeFromCms?: boolean;
  readonly captureLogs?: Record<string, unknown>[];
  readonly authorize?: boolean;
  /** Set to give the deployment a preview surface. Absent is a deployment with none — R12 off. */
  readonly previewBaseUrl?: string;
}

async function callProxy(
  action: string,
  params: Record<string, unknown>,
  options: ProxyCallOptions = {},
): Promise<{ status: number; body: unknown }> {
  const cms = await buildCmsTestApp({
    routes: options.routes ?? [],
    ...(options.allowMergeFromCms === undefined
      ? {}
      : { allowMergeFromCms: options.allowMergeFromCms }),
    ...(options.captureLogs === undefined ? {} : { captureLogs: options.captureLogs }),
    ...(options.previewBaseUrl === undefined ? {} : { previewBaseUrl: options.previewBaseUrl }),
  });

  const response = await cms.app.request(PROXY, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.authorize === false ? {} : await cms.authorize()),
    },
    body: JSON.stringify({ branch: 'main', action, params }),
  });

  return { status: response.status, body: await response.json() };
}

describe('the Decap adapter', () => {
  // The adapter is mounted inside the editorial sub-app, so it inherits R1 rather than restating
  // it. Asserting no upstream call left proves the refusal happened before the credential was used.
  describe('authentication (R1)', () => {
    it('refuses an unauthenticated call before reaching the git host', async () => {
      const cms = await buildCmsTestApp();

      const response = await cms.app.request(PROXY, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'unpublishedEntries', params: {} }),
      });

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: 'unauthorized',
        reason: 'missing-credential',
      });
      expect(cms.host.paths()).toEqual([]);
    });
  });

  // The one editorial path that is deliberately anonymous. It is mounted beside `/v1/cms` rather
  // than inside it, so that sub-app's "everything here needs a token" rule stays literally true.
  describe('the admin sign-in configuration', () => {
    it('is served without a token, because the page that needs it has none yet', async () => {
      const cms = await buildCmsTestApp();

      const response = await cms.app.request('/v1/admin/config');

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ authMode: 'bearer' });
      expect(cms.host.paths()).toEqual([]);
    });

    it('is absent when the CMS is switched off', async () => {
      const response = await buildTestApp().request('/v1/admin/config');

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: 'not_found' });
    });
  });

  describe('reading the corpus', () => {
    it('lists a collection with its content', async () => {
      const { status, body } = await callProxy(
        'entriesByFolder',
        { folder: 'docs/guides', extension: 'md', depth: 1 },
        { routes: MAIN_ROUTES },
      );

      expect(status).toBe(200);
      expect(body).toEqual([
        { data: '# Leave\n', file: { path: 'docs/guides/leave-policy.md', id: 'blob-leave' } },
      ]);
    });

    // The previous case pins depth 1 to the flat page; this one shows the nested page appearing
    // once the collection is configured deep enough to hold it. Order is tree order.
    it('admits a nested page once depth allows it', async () => {
      const { body } = await callProxy(
        'entriesByFolder',
        { folder: 'docs/guides', depth: 2 },
        { routes: MAIN_ROUTES },
      );

      expect(body).toMatchObject([
        { file: { path: 'docs/guides/leave-policy.md' } },
        { file: { path: 'docs/guides/deep/nested.md' } },
      ]);
    });

    // The adapter reuses DocumentReader, so R3's confinement applies to what an editor can even
    // see. A CMS that listed `.github/workflows/ci.yml` would be offering to edit it.
    it('never lists a path the corpus policy excludes', async () => {
      const { body } = await callProxy('entriesByFolder', { folder: '' }, { routes: MAIN_ROUTES });

      const paths = (body as { file: { path: string } }[]).map((entry) => entry.file.path);
      expect(paths).not.toContain('.github/workflows/ci.yml');
      expect(paths).not.toContain('docs/logo.png');
    });

    it('reads one entry, carrying the blob sha as its id', async () => {
      const { status, body } = await callProxy(
        'getEntry',
        { path: 'docs/index.md' },
        { routes: MAIN_ROUTES },
      );

      expect(status).toBe(200);
      expect(body).toEqual({
        data: '# Index\n',
        file: { path: 'docs/index.md', id: 'blob-index' },
      });
    });

    it('reads a named set of files', async () => {
      const { body } = await callProxy(
        'entriesByFiles',
        { files: [{ path: 'docs/index.md' }] },
        { routes: MAIN_ROUTES },
      );

      expect(body).toEqual([
        { data: '# Index\n', file: { path: 'docs/index.md', id: 'blob-index' } },
      ]);
    });
  });

  describe('the editorial board', () => {
    it('lists a draft branch as an unpublished entry', async () => {
      const { status, body } = await callProxy(
        'unpublishedEntries',
        {},
        { routes: [MATCHING_REFS] },
      );

      expect(status).toBe(200);
      expect(body).toEqual(['guides/leave-policy']);
    });

    // The save/submit split is the whole point of R7: a draft branch with no pull request is work
    // in progress, not something sitting in a reviewer's queue.
    it('reports a branch with no pull request as a draft', async () => {
      const { body } = await callProxy(
        'unpublishedEntry',
        { id: 'guides/leave-policy' },
        { routes: [...MAIN_ROUTES, ...DRAFT_ROUTES, pullsRoute([])] },
      );

      expect(body).toMatchObject({
        collection: 'guides',
        slug: 'leave-policy',
        status: 'draft',
        updatedAt: DRAFT_UPDATED_AT,
      });
    });

    it('reports a branch with an open pull request as in review', async () => {
      const { body } = await callProxy(
        'unpublishedEntry',
        { collection: 'guides', slug: 'leave-policy' },
        { routes: [...MAIN_ROUTES, ...DRAFT_ROUTES, pullsRoute([OPEN_PULL])] },
      );

      expect(body).toMatchObject({ status: 'pending_review' });
    });

    it('reports only the files the draft actually changes', async () => {
      const { body } = await callProxy(
        'unpublishedEntry',
        { id: 'guides/leave-policy' },
        { routes: [...MAIN_ROUTES, ...DRAFT_ROUTES, pullsRoute([])] },
      );

      // `docs/index.md` is byte-identical on both branches, so it is not a change. The uploaded
      // image is one, and has to be listed: Decap derives an entry's media from exactly this list
      // (requirements.md R15).
      expect((body as { diffs: unknown[] }).diffs).toEqual([
        { id: 'blob-leave-2', path: 'docs/guides/leave-policy.md', newFile: false },
        { id: 'blob-new', path: 'docs/guides/new-page.md', newFile: true },
        { id: 'blob-new-chart', path: `${MEDIA_FOLDER}new-chart.png`, newFile: true },
      ]);
    });

    // A merged draft whose branch outlived its pull request must leave the board, or the author
    // gets a card they can never move.
    it('treats a published draft as no longer in progress', async () => {
      const { status, body } = await callProxy(
        'unpublishedEntry',
        { id: 'guides/leave-policy' },
        {
          routes: [...DRAFT_ROUTES, pullsRoute([{ ...OPEN_PULL, state: 'closed', merged: true }])],
        },
      );

      expect(status).toBe(404);
      expect(body).toMatchObject({ reason: 'no-draft' });
    });

    it('answers 404 when the entry has no draft branch at all', async () => {
      const { status } = await callProxy(
        'unpublishedEntry',
        { id: 'guides/never-written' },
        {
          routes: [{ method: 'GET', path: /\/git\/ref\/heads\/cms\//, status: 404, respond: {} }],
        },
      );

      expect(status).toBe(404);
    });

    it('reads one file from a draft branch', async () => {
      const { status, body } = await callProxy(
        'unpublishedEntryDataFile',
        {
          collection: 'guides',
          slug: 'leave-policy',
          path: 'docs/guides/leave-policy.md',
        },
        { routes: DRAFT_ROUTES },
      );

      expect(status).toBe(200);
      expect(body).toBe('# Leave v2\n');
    });
  });

  describe('saving', () => {
    it('writes a draft branch and opens no pull request', async () => {
      const cms = await buildCmsTestApp({ routes: [...SAVE_ROUTES] });

      const response = await cms.app.request(PROXY, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await cms.authorize()) },
        body: JSON.stringify({
          action: 'persistEntry',
          params: {
            dataFiles: [
              {
                path: 'docs/guides/leave-policy.md',
                slug: 'leave-policy',
                raw: '# Leave\n',
              },
            ],
            options: { collectionName: 'guides', commitMessage: 'docs: rewrite leave' },
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ branch: DRAFT_BRANCH });
      expect(cms.host.paths()).not.toContain(`${REPO}/pulls`);
    });

    // R6: the author comes from the verified token, and the protocol has no field that could name
    // anyone else.
    it('attributes the commit to the verified author', async () => {
      const cms = await buildCmsTestApp({ routes: [...SAVE_ROUTES] });

      await cms.app.request(PROXY, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await cms.authorize()) },
        body: JSON.stringify({
          action: 'persistEntry',
          params: {
            dataFiles: [{ path: 'docs/guides/leave-policy.md', slug: 'leave-policy', raw: '#\n' }],
            options: { collectionName: 'guides' },
          },
        }),
      });

      const commit = cms.host.calls.find((call) => call.path === `${REPO}/git/commits`);
      expect(commit?.body).toMatchObject({
        author: { name: 'Sam Okoro', email: 'sam@example.com' },
      });
    });

    it('submits for review when the entry is saved as in review', async () => {
      const cms = await buildCmsTestApp({
        routes: [
          ...SAVE_ROUTES,
          pullsRoute([]),
          { method: 'POST', path: `${REPO}/pulls`, respond: OPEN_PULL },
        ],
      });

      await cms.app.request(PROXY, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await cms.authorize()) },
        body: JSON.stringify({
          action: 'persistEntry',
          params: {
            dataFiles: [{ path: 'docs/guides/leave-policy.md', slug: 'leave-policy', raw: '#\n' }],
            options: { collectionName: 'guides', status: 'pending_review' },
          },
        }),
      });

      const opened = cms.host.calls.find(
        (call) => call.method === 'POST' && call.path === `${REPO}/pulls`,
      );
      expect(opened?.body).toMatchObject({ head: DRAFT_BRANCH, base: 'main' });
    });

    // R3, through the adapter rather than the REST route: one bad entry refuses the whole change
    // set, before any upstream call.
    it('refuses a write outside the documentation prefixes', async () => {
      const cms = await buildCmsTestApp();

      const response = await cms.app.request(PROXY, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await cms.authorize()) },
        body: JSON.stringify({
          action: 'persistEntry',
          params: {
            dataFiles: [
              { path: '.github/workflows/ci.yml', slug: 'leave-policy', raw: 'run: rm -rf /\n' },
            ],
            options: { collectionName: 'guides' },
          },
        }),
      });

      expect(response.status).toBe(403);
      expect(cms.host.paths()).toEqual([]);
    });

    it('refuses a slug that could not be a branch name', async () => {
      const cms = await buildCmsTestApp();

      const response = await cms.app.request(PROXY, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await cms.authorize()) },
        body: JSON.stringify({
          action: 'persistEntry',
          params: {
            dataFiles: [{ path: 'docs/guides/a.md', slug: 'leave policy', raw: '#\n' }],
            options: { collectionName: 'guides' },
          },
        }),
      });

      expect(response.status).toBe(403);
      expect(cms.host.paths()).toEqual([]);
    });

    // requirements.md R15, and the whole of its write path: an image arrives with the entry, so it
    // is committed with the page rather than written to the default branch. See ADR 0021.
    describe('with images', () => {
      async function save(
        assets: readonly unknown[],
        routes: readonly FakeGitHubRoute[] = SAVE_ROUTES,
      ) {
        const cms = await buildCmsTestApp({ routes: [...routes] });

        const response = await cms.app.request(PROXY, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(await cms.authorize()) },
          body: JSON.stringify({
            action: 'persistEntry',
            params: {
              dataFiles: [
                { path: 'docs/guides/leave-policy.md', slug: 'leave-policy', raw: '# Leave\n' },
              ],
              assets,
              options: { collectionName: 'guides' },
            },
          }),
        });

        return { cms, status: response.status, body: await response.json() };
      }

      const CHART = {
        path: `${MEDIA_FOLDER}org-chart.png`,
        content: PNG_BASE64,
        encoding: 'base64',
      };

      it('commits the image and the page together, in one commit', async () => {
        const { cms, status, body } = await save([CHART]);

        expect(status).toBe(200);
        expect(body).toEqual({ branch: DRAFT_BRANCH });

        const blobs = cms.host.calls.filter(
          (call) => call.method === 'POST' && call.path === `${REPO}/git/blobs`,
        );
        const commits = cms.host.calls.filter(
          (call) => call.method === 'POST' && call.path === `${REPO}/git/commits`,
        );

        expect(blobs).toHaveLength(2);
        expect(commits).toHaveLength(1);
      });

      // The bytes must reach the git host as they arrived. Re-encoding them through a UTF-8 string
      // would not merely waste work — it would corrupt the image, and nothing would say so.
      it('sends the image bytes through unchanged', async () => {
        const { cms } = await save([CHART]);

        const blobs = cms.host.calls.filter(
          (call) => call.method === 'POST' && call.path === `${REPO}/git/blobs`,
        );

        expect(blobs.map((call) => (call.body as { content: string }).content)).toContain(
          PNG_BASE64,
        );
      });

      it('puts the image in the same tree as the page', async () => {
        const { cms } = await save([CHART]);

        const tree = cms.host.calls.find(
          (call) => call.method === 'POST' && call.path === `${REPO}/git/trees`,
        );

        expect(
          (tree?.body as { tree: { path: string }[] }).tree.map((entry) => entry.path),
        ).toEqual(['docs/guides/leave-policy.md', `${MEDIA_FOLDER}org-chart.png`]);
      });

      // R15's second acceptance criterion. "Nothing is written" is the part worth asserting: an
      // author gets one refusal to act on rather than a half-applied commit to unpick.
      it('refuses an oversized image, naming both sizes, and writes nothing at all', async () => {
        const { cms, status, body } = await save([{ ...CHART, content: oversizedPng() }]);

        expect(status).toBe(413);
        expect(body).toMatchObject({ reason: 'media-too-large' });
        expect((body as { error: string }).error).toContain('org-chart.png');
        expect((body as { error: string }).error).toContain('4 kB');
        expect(cms.host.paths()).toEqual([]);
      });

      it.each([
        ['an svg, which could carry a script', `${MEDIA_FOLDER}diagram.svg`, PNG_BASE64],
        ['an executable', `${MEDIA_FOLDER}payload.exe`, PNG_BASE64],
        ['an image outside the media folder', 'docs/guides/inline.png', PNG_BASE64],
        ['traversal out of the folder', `${MEDIA_FOLDER}../../ci.png`, PNG_BASE64],
        ['html wearing a png name', `${MEDIA_FOLDER}x.png`, base64('<!doctype html>')],
        ['a payload that is not base64 at all', `${MEDIA_FOLDER}x.png`, 'not base64 %%%'],
      ])('refuses %s, and writes nothing', async (_case, path, content) => {
        const { cms, status } = await save([{ path, content, encoding: 'base64' }]);

        expect(status).toBe(403);
        expect(cms.host.paths()).toEqual([]);
      });

      // One bad image refuses the whole save, exactly as one bad path does — R3's rule applied to
      // media, and the reason the checks run before the first upstream call.
      it('refuses the whole save when only one of several images is bad', async () => {
        const { cms, status } = await save([
          CHART,
          { path: `${MEDIA_FOLDER}payload.exe`, content: PNG_BASE64, encoding: 'base64' },
        ]);

        expect(status).toBe(403);
        expect(cms.host.paths()).toEqual([]);
      });

      it('refuses more images in one save than the protocol admits', async () => {
        const { cms, status } = await save(
          Array.from({ length: 9 }, (_unused, index) => ({
            ...CHART,
            path: `${MEDIA_FOLDER}chart-${String(index)}.png`,
          })),
        );

        expect(status).toBe(400);
        expect(cms.host.paths()).toEqual([]);
      });

      it('saves a page with no images exactly as it did before', async () => {
        const { status, body } = await save([]);

        expect(status).toBe(200);
        expect(body).toEqual({ branch: DRAFT_BRANCH });
      });
    });
  });

  describe('moving between columns', () => {
    it('opens a pull request when an author sends a draft for review', async () => {
      const cms = await buildCmsTestApp({
        routes: [
          ...MAIN_ROUTES,
          ...DRAFT_ROUTES,
          pullsRoute([]),
          { method: 'POST', path: `${REPO}/pulls`, respond: OPEN_PULL },
        ],
      });

      const response = await cms.app.request(PROXY, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await cms.authorize()) },
        body: JSON.stringify({
          action: 'updateUnpublishedEntryStatus',
          params: { collection: 'guides', slug: 'leave-policy', newStatus: 'pending_review' },
        }),
      });

      expect(response.status).toBe(200);
      expect(
        cms.host.calls.some((call) => call.method === 'POST' && call.path === `${REPO}/pulls`),
      ).toBe(true);
    });

    // Withdrawing closes the pull request and leaves the branch alone: the author asked to keep
    // editing, not to throw the work away.
    it('closes the pull request when an author takes a change back to draft', async () => {
      const cms = await buildCmsTestApp({
        routes: [
          ...MAIN_ROUTES,
          ...DRAFT_ROUTES,
          pullsRoute([OPEN_PULL]),
          { method: 'GET', path: `${REPO}/pulls/42`, respond: OPEN_PULL },
          { method: 'PATCH', path: `${REPO}/pulls/42`, respond: { ...OPEN_PULL, state: 'closed' } },
        ],
      });

      await cms.app.request(PROXY, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await cms.authorize()) },
        body: JSON.stringify({
          action: 'updateUnpublishedEntryStatus',
          params: { collection: 'guides', slug: 'leave-policy', newStatus: 'draft' },
        }),
      });

      const patched = cms.host.calls.find((call) => call.method === 'PATCH');
      expect(patched?.body).toEqual({ state: 'closed' });
      expect(cms.host.calls.some((call) => call.method === 'DELETE')).toBe(false);
    });

    it('does not open a second pull request for a draft already in review', async () => {
      const cms = await buildCmsTestApp({
        routes: [...MAIN_ROUTES, ...DRAFT_ROUTES, pullsRoute([OPEN_PULL])],
      });

      const response = await cms.app.request(PROXY, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await cms.authorize()) },
        body: JSON.stringify({
          action: 'updateUnpublishedEntryStatus',
          params: { collection: 'guides', slug: 'leave-policy', newStatus: 'pending_review' },
        }),
      });

      expect(response.status).toBe(200);
      expect(
        cms.host.calls.some((call) => call.method === 'POST' && call.path === `${REPO}/pulls`),
      ).toBe(false);
    });

    it('discards a draft by closing its pull request and deleting the branch', async () => {
      const cms = await buildCmsTestApp({
        routes: [
          pullsRoute([OPEN_PULL]),
          { method: 'GET', path: `${REPO}/pulls/42`, respond: OPEN_PULL },
          { method: 'PATCH', path: `${REPO}/pulls/42`, respond: { ...OPEN_PULL, state: 'closed' } },
          { method: 'DELETE', path: /\/git\/refs\/heads\/cms\//, status: 204 },
        ],
      });

      const response = await cms.app.request(PROXY, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await cms.authorize()) },
        body: JSON.stringify({
          action: 'deleteUnpublishedEntry',
          params: { collection: 'guides', slug: 'leave-policy' },
        }),
      });

      expect(response.status).toBe(200);
      expect(cms.host.calls.some((call) => call.method === 'DELETE')).toBe(true);
    });
  });

  // requirements.md R7 and R8: approval happens in the git host, where branch protection can
  // require a code-owner review that no principal — including the App — can bypass.
  describe('publishing', () => {
    it('is refused by default, with a reason an author can read', async () => {
      const { status, body } = await callProxy(
        'publishUnpublishedEntry',
        { collection: 'guides', slug: 'leave-policy' },
        { routes: [pullsRoute([OPEN_PULL])] },
      );

      expect(status).toBe(403);
      expect(body).toMatchObject({ reason: 'merge-disabled' });
      expect((body as { error: string }).error).toContain('POLICY_ALLOW_MERGE_FROM_CMS');
    });

    it('merges once the policy flag is set', async () => {
      const cms = await buildCmsTestApp({
        allowMergeFromCms: true,
        routes: [
          pullsRoute([OPEN_PULL]),
          { method: 'GET', path: `${REPO}/pulls/42`, respond: OPEN_PULL },
          { method: 'PUT', path: `${REPO}/pulls/42/merge`, respond: { merged: true } },
        ],
      });

      const response = await cms.app.request(PROXY, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await cms.authorize()) },
        body: JSON.stringify({
          action: 'publishUnpublishedEntry',
          params: { collection: 'guides', slug: 'leave-policy' },
        }),
      });

      expect(response.status).toBe(200);
      expect(cms.host.calls.some((call) => call.method === 'PUT')).toBe(true);
    });
  });

  // requirements.md R12: "the preview link is visible on the CMS workflow card". Decap polls this
  // action per card and renders whatever URL it gets, so `null` is a real answer rather than a
  // failure — it keeps the card offering to check instead of linking at a build that is not there.
  describe('preview links (R12)', () => {
    const PREVIEW_BASE_URL = 'https://kb.test/previews';

    it('links the card to the preview for the open submission', async () => {
      const { status, body } = await callProxy('getDeployPreview', ENTRY, {
        routes: [pullsRoute([OPEN_PULL])],
        previewBaseUrl: PREVIEW_BASE_URL,
      });

      expect(status).toBe(200);
      expect(body).toEqual({ url: 'https://kb.test/previews/pr-42/', status: 'SUCCESS' });
    });

    it('offers no preview for a draft nobody has submitted yet', async () => {
      const { status, body } = await callProxy('getDeployPreview', ENTRY, {
        routes: [pullsRoute([])],
        previewBaseUrl: PREVIEW_BASE_URL,
      });

      expect(status).toBe(200);
      expect(body).toBeNull();
    });

    // The default deployment. No preview bucket means no preview surface, and the card must say
    // so rather than linking at a URL that would 404.
    it('offers no preview when the deployment has no preview surface', async () => {
      const { status, body } = await callProxy('getDeployPreview', ENTRY, {
        routes: [pullsRoute([OPEN_PULL])],
      });

      expect(status).toBe(200);
      expect(body).toBeNull();
    });

    it('refuses a request that names no entry', async () => {
      const { status, body } = await callProxy(
        'getDeployPreview',
        {},
        { previewBaseUrl: PREVIEW_BASE_URL },
      );

      expect(status).toBe(403);
      expect(body).toMatchObject({ reason: 'invalid-entry' });
    });
  });

  // requirements.md R15. The write half lives in "saving an entry" above, because an upload is not
  // a write of its own — it travels with the page (ADR 0021).
  describe('the media library', () => {
    it('lists the images in the media folder, with their bytes', async () => {
      const { status, body } = await callProxy(
        'getMedia',
        { mediaFolder: MEDIA_FOLDER },
        { routes: MAIN_ROUTES },
      );

      expect(status).toBe(200);
      expect(body).toEqual([
        {
          id: 'blob-chart',
          path: `${MEDIA_FOLDER}org-chart.png`,
          name: 'org-chart.png',
          content: PNG_BASE64,
          encoding: 'base64',
        },
      ]);
    });

    // The gateway knows which folder it confines uploads to. Reading the parameter would make the
    // browser the authority on what the one credential may fetch, for no gain.
    it('ignores the folder the browser names, and answers for the configured one', async () => {
      const { status, body } = await callProxy(
        'getMedia',
        { mediaFolder: '.github/workflows' },
        { routes: MAIN_ROUTES },
      );

      expect(status).toBe(200);
      expect(body).toMatchObject([{ path: `${MEDIA_FOLDER}org-chart.png` }]);
    });

    it('reads one image from the published corpus', async () => {
      const { status, body } = await callProxy(
        'getMediaFile',
        { path: `${MEDIA_FOLDER}org-chart.png` },
        { routes: MAIN_ROUTES },
      );

      expect(status).toBe(200);
      expect(body).toMatchObject({ name: 'org-chart.png', content: PNG_BASE64 });
    });

    // What keeps an uploaded image visible after a reload: it is on the draft branch, and the
    // published corpus does not have it yet.
    it("reads a draft's own image from the draft branch", async () => {
      const { status, body } = await callProxy(
        'unpublishedEntryMediaFile',
        { ...ENTRY, path: `${MEDIA_FOLDER}new-chart.png` },
        { routes: DRAFT_ROUTES },
      );

      expect(status).toBe(200);
      expect(body).toMatchObject({ id: 'blob-new-chart', name: 'new-chart.png' });
    });

    // Decap derives an entry's media from the diffs, so an image missing here is an image that
    // vanishes from the editor while sitting on the branch all along.
    it('reports a draft image as a changed file', async () => {
      const { status, body } = await callProxy('unpublishedEntry', ENTRY, {
        routes: [...MAIN_ROUTES, ...DRAFT_ROUTES, pullsRoute([])],
      });

      expect(status).toBe(200);
      expect(body).toMatchObject({
        diffs: expect.arrayContaining([
          { id: 'blob-new-chart', path: `${MEDIA_FOLDER}new-chart.png`, newFile: true },
        ]),
      });
    });

    // The board asks for this per card on every refresh, so its cost is worth pinning. Asking the
    // document reader for the pages and the media service for the images is the obvious composition
    // and reads each branch's tree twice; one listing per branch, applying both policies, does not.
    it('reads each branch once to find them, not once per kind of file', async () => {
      const cms = await buildCmsTestApp({
        routes: [...MAIN_ROUTES, ...DRAFT_ROUTES, pullsRoute([])],
      });

      await cms.app.request(PROXY, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await cms.authorize()) },
        body: JSON.stringify({ action: 'unpublishedEntry', params: ENTRY }),
      });

      const trees = cms.host.paths().filter((path) => path.includes('/git/trees/'));
      expect(trees).toEqual([
        `${REPO}/git/trees/${DRAFT_TREE}?recursive=1`,
        `${REPO}/git/trees/${MAIN_TREE}?recursive=1`,
      ]);
    });

    it.each([
      ['markdown pretending to be media', `${MEDIA_FOLDER}notes.md`],
      ['an image outside the media folder', 'docs/logo.png'],
      ['traversal out of the folder', `${MEDIA_FOLDER}../../.github/workflows/ci.png`],
    ])('refuses to read %s, before any upstream call', async (_case, path) => {
      const cms = await buildCmsTestApp({ routes: MAIN_ROUTES });

      const response = await cms.app.request(PROXY, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await cms.authorize()) },
        body: JSON.stringify({ action: 'getMediaFile', params: { path } }),
      });

      expect(response.status).toBe(403);
      expect(cms.host.paths()).toEqual([]);
    });

    // Decap's own git backends answer persistMedia by committing to the default branch, which
    // branch policy and branch protection both refuse. The author is sent somewhere that works.
    it('refuses a standalone upload, and says where to put the image instead', async () => {
      const { status, body } = await callProxy('persistMedia', {
        asset: { path: `${MEDIA_FOLDER}x.png`, content: PNG_BASE64, encoding: 'base64' },
      });

      expect(status).toBe(400);
      expect(body).toMatchObject({ reason: 'unsupported-action' });
      expect((body as { error: string }).error).toContain('inside the page');
    });

    it('refuses to delete a published image directly', async () => {
      const { status, body } = await callProxy('deleteMedia', {
        path: `${MEDIA_FOLDER}org-chart.png`,
      });

      expect(status).toBe(400);
      expect((body as { error: string }).error).toContain('submit that for review');
    });
  });

  describe('what it does not do', () => {
    it('refuses an action it does not implement', async () => {
      const { status, body } = await callProxy('dropDatabase', {});

      expect(status).toBe(400);
      expect(body).toMatchObject({ reason: 'unsupported-action' });
    });

    it('refuses to delete a published page directly', async () => {
      const { status, body } = await callProxy('deleteFiles', { paths: ['docs/index.md'] });

      expect(status).toBe(400);
      expect((body as { error: string }).error).toContain('submit it for review');
    });
  });

  describe('malformed requests', () => {
    it('refuses a body that is not JSON', async () => {
      const cms = await buildCmsTestApp();

      const response = await cms.app.request(PROXY, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await cms.authorize()) },
        body: 'not json',
      });

      expect(response.status).toBe(400);
      expect(cms.host.paths()).toEqual([]);
    });

    it('refuses an envelope with no action', async () => {
      const { status } = await callProxy('', {});

      expect(status).toBe(400);
    });

    // A body this large never reaches a handler, so this middleware is the only place the refusal
    // can be worded — and it has to name the per-image limit, or an author is told a number they
    // cannot act on (requirements.md R15).
    it('refuses a body larger than the whole editor accepts, in words an author can act on', async () => {
      const cms = await buildCmsTestApp();

      const response = await cms.app.request(PROXY, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await cms.authorize()) },
        body: JSON.stringify({
          action: 'persistEntry',
          params: { dataFiles: [{ path: 'docs/a.md', slug: 'a', raw: 'x'.repeat(600_000) }] },
        }),
      });

      expect(response.status).toBe(413);
      expect((await response.json()) as { reason: string }).toMatchObject({
        reason: 'body-too-large',
      });
      expect(cms.host.paths()).toEqual([]);
    });

    // A stale save arrives as the git host's "Update is not a fast forward", which is true and
    // useless to an author who has just lost track of what happened to their page.
    it('explains a stale save in words an author can act on', async () => {
      const cms = await buildCmsTestApp({
        routes: [
          ...MAIN_ROUTES,
          {
            method: 'GET',
            path: `${REPO}/git/ref/heads/${DRAFT_BRANCH}`,
            respond: { object: { sha: DRAFT_COMMIT } },
          },
          {
            method: 'GET',
            path: `${REPO}/git/commits/${DRAFT_COMMIT}`,
            respond: { tree: { sha: DRAFT_TREE } },
          },
          { method: 'POST', path: `${REPO}/git/blobs`, respond: { sha: 'blob-written' } },
          { method: 'POST', path: `${REPO}/git/trees`, respond: { sha: 'tree-written' } },
          { method: 'POST', path: `${REPO}/git/commits`, respond: { sha: 'commit-written' } },
          {
            method: 'PATCH',
            path: /\/git\/refs\/heads\/cms\//,
            status: 422,
            respond: { message: 'Update is not a fast forward' },
          },
        ],
      });

      const response = await cms.app.request(PROXY, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await cms.authorize()) },
        body: JSON.stringify({
          action: 'persistEntry',
          params: {
            dataFiles: [{ path: 'docs/guides/leave-policy.md', slug: 'leave-policy', raw: '#\n' }],
            options: { collectionName: 'guides' },
          },
        }),
      });

      expect(response.status).toBe(409);
      expect((await response.json()) as { error: string }).toMatchObject({
        error: expect.stringContaining('moved since you opened it') as unknown,
      });
    });

    // Decap shows `error` to the person editing, so a validation failure has to read as a sentence
    // rather than as the string "invalid_request".
    it('describes a bad payload in the field the editor displays', async () => {
      const { status, body } = await callProxy('persistEntry', { dataFiles: [] });

      expect(status).toBe(400);
      expect((body as { error: string }).error).not.toBe('invalid_request');
      expect((body as { error: string }).error.length).toBeGreaterThan(0);
    });
  });

  // requirements.md R9. One endpoint carries every operation, so without the action the audit log
  // could not tell a draft save from an attempt to publish.
  describe('audit (R9)', () => {
    it('records the action, not just the path', async () => {
      const lines: Record<string, unknown>[] = [];
      await callProxy('unpublishedEntries', {}, { routes: [MATCHING_REFS], captureLogs: lines });

      expect(lines).toContainEqual(
        expect.objectContaining({
          path: PROXY,
          action: 'unpublishedEntries',
          decision: 'allowed',
          email: 'sam@example.com',
        }) as unknown,
      );
    });

    it('names the action on a refusal too', async () => {
      const lines: Record<string, unknown>[] = [];
      await callProxy(
        'publishUnpublishedEntry',
        { collection: 'guides', slug: 'leave-policy' },
        {
          routes: [pullsRoute([OPEN_PULL])],
          captureLogs: lines,
        },
      );

      expect(lines).toContainEqual(
        expect.objectContaining({
          action: 'publishUnpublishedEntry',
          decision: 'refused',
          reason: 'merge-disabled',
        }) as unknown,
      );
    });
  });
});
