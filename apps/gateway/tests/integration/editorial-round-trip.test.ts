import { describe, expect, it } from 'vitest';

import {
  buildStatefulCmsTestApp,
  type StatefulTestCms,
  TEST_MEDIA_FOLDER,
  TEST_REPOSITORY,
} from '../helpers/build-test-app';
import { type FakeGitHost, fakeGitHost } from '../helpers/fake-git-host';
import { type RepoState, type SeedFile } from '../helpers/git-repo';
import { requestUrl } from '../helpers/request-url';

/**
 * The editorial workflow as an author experiences it, against a git host that keeps what it is
 * given (`helpers/fake-git-host.ts`).
 *
 * This is the assertion the canned-route suites cannot make. `cms.test.ts` and
 * `decap-proxy.test.ts` declare each upstream response, which is exactly right for proving *which*
 * calls the gateway makes — that is what guards the endpoint allowlist, and they keep doing it.
 * But with a table, the read that follows a write is a different fixture from the write, so
 * "the page I saved comes back" is not something they can say. Here it is, because the same
 * repository answers both.
 *
 * Everything below the HTTP boundary is the production code path: the same `createApp`, the same
 * branch, path and endpoint policies, real JWT verification.
 */

const COLLECTION = 'docs';
const SLUG = 'leave-policy';
const PAGE = 'docs/leave-policy.md';
/** `cms/<collection>/<slug>` — the shape `entry-branch.ts` can read an entry back out of. */
const DRAFT_BRANCH = `cms/${COLLECTION}/${SLUG}`;
const IMAGE = `${TEST_MEDIA_FOLDER}chart.png`;

/** A one-pixel PNG. The media policy checks a real format signature, not a placeholder string. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAd8s6BwAAAABJRU5ErkJggg==';

const SEED: Readonly<Record<string, SeedFile>> = {
  [PAGE]: {
    content:
      '---\ntitle: Leave policy\nowner: people\nlast_reviewed: 2026-08-01\n---\n\nTake it.\n',
  },
  'docs/index.md': {
    content: '---\ntitle: Handbook\nowner: people\nlast_reviewed: 2026-08-01\n---\n\nHello.\n',
  },
};

function host(): FakeGitHost {
  return fakeGitHost({ repository: TEST_REPOSITORY, seed: SEED });
}

async function harness(allowMergeFromCms = false): Promise<StatefulTestCms> {
  return buildStatefulCmsTestApp({ host: host(), allowMergeFromCms });
}

/** Saves a draft through the REST surface. Text only — images arrive as Decap assets. */
async function save(
  cms: StatefulTestCms,
  branch: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await cms.app.request(`/v1/cms/drafts/${branch}`, {
    method: 'PUT',
    headers: { ...(await cms.authorize()), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function proxy(
  cms: StatefulTestCms,
  action: string,
  params: Record<string, unknown>,
): Promise<Response> {
  return cms.app.request('/v1/cms/proxy', {
    method: 'POST',
    headers: { ...(await cms.authorize()), 'content-type': 'application/json' },
    body: JSON.stringify({ action, params }),
  });
}

/** A save as the editor makes it: the page, and any images the author added while it was open. */
async function persistEntry(
  cms: StatefulTestCms,
  raw: string,
  assets: { path: string; content: string; encoding: 'base64' }[] = [],
): Promise<Response> {
  return proxy(cms, 'persistEntry', {
    dataFiles: [{ path: PAGE, slug: SLUG, raw }],
    assets,
    options: { collectionName: COLLECTION, commitMessage: 'docs: edit', status: 'draft' },
  });
}

async function readDocument(
  cms: StatefulTestCms,
  path: string,
  branch: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await cms.app.request(`/v1/cms/documents/${path}?branch=${branch}`, {
    headers: await cms.authorize(),
  });

  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('the editorial round trip', () => {
  describe('saving a draft', () => {
    it('makes the page readable on the draft branch', async () => {
      const cms = await harness();

      const saved = await save(cms, DRAFT_BRANCH, {
        files: [{ path: PAGE, content: '---\ntitle: Leave policy\n---\n\nTake more of it.\n' }],
      });
      expect(saved.status).toBe(201);
      expect(saved.body).toMatchObject({ branch: DRAFT_BRANCH, created: true });

      const document = await readDocument(cms, PAGE, DRAFT_BRANCH);
      expect(document.status).toBe(200);
      expect(document.body['content']).toContain('Take more of it.');
    });

    // The point of branching: the default branch is published content, and a draft must not reach
    // it until a reviewer says so (requirements.md R4).
    it('leaves the default branch untouched', async () => {
      const cms = await harness();

      await save(cms, DRAFT_BRANCH, { files: [{ path: PAGE, content: 'Take more of it.\n' }] });

      const published = await readDocument(cms, PAGE, 'main');
      expect(published.body['content']).toContain('Take it.');
    });

    it('creates a new page that was not in the corpus', async () => {
      const cms = await harness();

      await save(cms, 'cms/docs/expenses', {
        files: [{ path: 'docs/expenses.md', content: '# Expenses\n' }],
      });

      const listing = await cms.app.request('/v1/cms/documents?branch=cms/docs/expenses', {
        headers: await cms.authorize(),
      });
      const { documents } = (await listing.json()) as { documents: { path: string }[] };
      expect(documents.map((document) => document.path)).toContain('docs/expenses.md');
    });

    it('moves the branch on the second save rather than creating it again', async () => {
      const cms = await harness();

      const first = await save(cms, DRAFT_BRANCH, { files: [{ path: PAGE, content: 'One.\n' }] });
      const second = await save(cms, DRAFT_BRANCH, { files: [{ path: PAGE, content: 'Two.\n' }] });

      expect(first.body['created']).toBe(true);
      expect(second.status).toBe(200);
      expect(second.body['created']).toBe(false);
      expect(second.body['commitSha']).not.toBe(first.body['commitSha']);

      const document = await readDocument(cms, PAGE, DRAFT_BRANCH);
      expect(document.body['content']).toBe('Two.\n');
    });

    it('deletes a page and keeps the rest of the tree', async () => {
      const cms = await harness();

      await save(cms, DRAFT_BRANCH, { deletions: [PAGE] });

      expect((await readDocument(cms, PAGE, DRAFT_BRANCH)).status).toBe(404);
      expect((await readDocument(cms, 'docs/index.md', DRAFT_BRANCH)).status).toBe(200);
    });
  });

  // requirements.md R15 and ADR 0021. The REST draft route takes text; an image reaches the
  // repository as a Decap asset, which is the path the editor actually uses.
  describe('an image added to a page', () => {
    it('travels to the draft branch in the same commit as the page', async () => {
      const cms = await harness();

      const response = await persistEntry(cms, '![chart](/media/chart.png)\n', [
        { path: IMAGE, content: PNG_BASE64, encoding: 'base64' },
      ]);
      expect(response.status).toBe(200);

      const tip = cms.host.repo.getRef(DRAFT_BRANCH) ?? '';
      const commit = cms.host.repo.readCommit(tip);
      const tree = cms.host.repo.readTree(commit.tree);

      expect(Object.keys(tree)).toContain(IMAGE);
      expect(Object.keys(tree)).toContain(PAGE);
      // One commit on top of the base, not two: a reviewer never sees a page whose image is
      // missing because the second commit had not landed yet.
      expect(commit.parents).toHaveLength(1);
    });

    // The bytes have to survive the round trip. Re-encoding a PNG through a UTF-8 string corrupts
    // it, and the corruption is invisible until somebody opens the page.
    it('comes back byte for byte', async () => {
      const cms = await harness();
      await persistEntry(cms, '![chart](/media/chart.png)\n', [
        { path: IMAGE, content: PNG_BASE64, encoding: 'base64' },
      ]);

      const response = await proxy(cms, 'unpublishedEntryMediaFile', {
        collection: COLLECTION,
        slug: SLUG,
        path: IMAGE,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        path: IMAGE,
        encoding: 'base64',
        content: PNG_BASE64,
      });
    });
  });

  /**
   * The failure an author actually hits: they save, and somebody else has saved the same page
   * since they opened it. The wrapped `fetch` makes that happen at the one instant it matters —
   * between this save reading the branch tip and moving it — so the assertion is deterministic
   * rather than a race two requests might win in either order.
   */
  describe('a draft that moved underneath the author', () => {
    async function withInterloper(): Promise<StatefulTestCms> {
      const live = host();
      let armed = false;

      const intercepted: FakeGitHost = {
        ...live,
        fetch: ((input: string | URL | Request, init?: RequestInit) => {
          const url = requestUrl(input);
          if (armed && (init?.method ?? 'GET') === 'PATCH' && url.includes('/git/refs/heads/')) {
            armed = false;
            const tip = live.repo.getRef(DRAFT_BRANCH) ?? '';
            const tree = live.repo.createTree(live.repo.readCommit(tip).tree, [
              {
                path: PAGE,
                sha: live.repo.createBlob(Buffer.from('Theirs.\n', 'utf8').toString('base64')),
              },
            ]);
            live.repo.updateRef(
              DRAFT_BRANCH,
              live.repo.createCommit({ message: 'docs: their edit', tree, parents: [tip] }),
              false,
            );
          }
          return live.fetch(input, init);
        }) as typeof globalThis.fetch,
      };

      const cms = await buildStatefulCmsTestApp({ host: intercepted });
      await save(cms, DRAFT_BRANCH, { files: [{ path: PAGE, content: 'Base.\n' }] });
      armed = true;
      return cms;
    }

    it('refuses the stale save with a conflict', async () => {
      const cms = await withInterloper();

      const stale = await save(cms, DRAFT_BRANCH, { files: [{ path: PAGE, content: 'Mine.\n' }] });

      expect(stale.status).toBe(409);
    });

    it('tells the author what happened rather than repeating git', async () => {
      const cms = await withInterloper();

      const stale = await persistEntry(cms, 'Mine.\n');

      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({
        error: expect.stringContaining('moved since you opened it'),
      });
    });

    it('keeps the other author’s work', async () => {
      const cms = await withInterloper();
      await save(cms, DRAFT_BRANCH, { files: [{ path: PAGE, content: 'Mine.\n' }] });

      expect((await readDocument(cms, PAGE, DRAFT_BRANCH)).body['content']).toBe('Theirs.\n');
    });
  });

  describe('the editorial board', () => {
    it('lists a draft that has no pull request yet', async () => {
      const cms = await harness();
      await save(cms, DRAFT_BRANCH, { files: [{ path: PAGE, content: 'Draft.\n' }] });

      const response = await proxy(cms, 'unpublishedEntries', {});

      expect(response.status).toBe(200);
      expect(JSON.stringify(await response.json())).toContain(SLUG);
    });

    it('drops the draft from the board once it is discarded', async () => {
      const cms = await harness();
      await save(cms, DRAFT_BRANCH, { files: [{ path: PAGE, content: 'Draft.\n' }] });

      const discarded = await cms.app.request(`/v1/cms/drafts/${DRAFT_BRANCH}`, {
        method: 'DELETE',
        headers: await cms.authorize(),
      });

      expect(discarded.status).toBe(204);
      expect(cms.host.repo.getRef(DRAFT_BRANCH)).toBeUndefined();
    });
  });

  describe('submitting for review', () => {
    async function submit(cms: StatefulTestCms): Promise<{ number: number }> {
      const response = await cms.app.request('/v1/cms/submissions', {
        method: 'POST',
        headers: { ...(await cms.authorize()), 'content-type': 'application/json' },
        body: JSON.stringify({ branch: DRAFT_BRANCH, title: 'Rewrite the leave policy' }),
      });
      return (await response.json()) as { number: number };
    }

    it('opens a pull request that is then readable and listed', async () => {
      const cms = await harness();
      await save(cms, DRAFT_BRANCH, { files: [{ path: PAGE, content: 'Ready.\n' }] });

      const submission = await submit(cms);
      expect(submission.number).toBeGreaterThan(0);

      const read = await cms.app.request(`/v1/cms/submissions/${String(submission.number)}`, {
        headers: await cms.authorize(),
      });
      expect(await read.json()).toMatchObject({
        branch: DRAFT_BRANCH,
        base: 'main',
        state: 'open',
        title: 'Rewrite the leave policy',
      });

      const listed = await cms.app.request('/v1/cms/submissions', {
        headers: await cms.authorize(),
      });
      const { submissions } = (await listed.json()) as { submissions: { number: number }[] };
      expect(submissions.map((entry) => entry.number)).toContain(submission.number);
    });

    // requirements.md R6: the reviewer is told whose words they are approving, from the verified
    // token and from nowhere a client could set.
    it('names the verified submitter in the pull request body', async () => {
      const cms = await harness();
      await save(cms, DRAFT_BRANCH, { files: [{ path: PAGE, content: 'Ready.\n' }] });

      const submission = await submit(cms);

      expect(cms.host.repo.readPull(submission.number).body).toContain('sam@example.com');
    });

    it('publishes the draft onto the default branch when merging is allowed', async () => {
      const cms = await harness(true);
      await save(cms, DRAFT_BRANCH, { files: [{ path: PAGE, content: 'Published words.\n' }] });
      const submission = await submit(cms);

      const merged = await cms.app.request(
        `/v1/cms/submissions/${String(submission.number)}/merge`,
        { method: 'POST', headers: await cms.authorize() },
      );

      expect(merged.status).toBe(200);
      expect(await merged.json()).toMatchObject({ state: 'merged' });
      expect((await readDocument(cms, PAGE, 'main')).body['content']).toBe('Published words.\n');
    });

    // The default is off, and it is off in the endpoint allowlist too — so this refusal costs no
    // upstream call at all (requirements.md R7).
    it('refuses to merge when the policy flag is not set', async () => {
      const cms = await harness();
      await save(cms, DRAFT_BRANCH, { files: [{ path: PAGE, content: 'Ready.\n' }] });
      const submission = await submit(cms);

      const merged = await cms.app.request(
        `/v1/cms/submissions/${String(submission.number)}/merge`,
        { method: 'POST', headers: await cms.authorize() },
      );

      expect(merged.status).toBe(403);
      expect(await merged.json()).toMatchObject({ reason: 'merge-disabled' });
      expect(cms.host.repo.readPull(submission.number).merged).toBe(false);
      expect((await readDocument(cms, PAGE, 'main')).body['content']).toContain('Take it.');
    });
  });

  // The state is plain JSON precisely so the local sandbox can write it to disk and pick the same
  // drafts up tomorrow. If it stopped round-tripping, a restart would silently lose work.
  describe('the repository snapshot', () => {
    it('carries a draft through a serialise and reload', async () => {
      const cms = await harness();
      await save(cms, DRAFT_BRANCH, { files: [{ path: PAGE, content: 'Survives.\n' }] });

      const state = JSON.parse(JSON.stringify(cms.host.repo.snapshot())) as RepoState;
      const reloaded = fakeGitHost({ repository: TEST_REPOSITORY, state });

      const tip = reloaded.repo.getRef(DRAFT_BRANCH);
      expect(tip).toBe(cms.host.repo.getRef(DRAFT_BRANCH));

      const tree = reloaded.repo.readTree(reloaded.repo.readCommit(String(tip)).tree);
      expect(Buffer.from(reloaded.repo.readBlob(String(tree[PAGE])), 'base64').toString()).toBe(
        'Survives.\n',
      );
    });
  });
});
