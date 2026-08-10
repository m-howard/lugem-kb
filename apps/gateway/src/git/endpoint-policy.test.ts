import { describe, expect, it } from 'vitest';

import { checkEndpoint, type EndpointViolation } from './endpoint-policy';

const OPTIONS = { repository: 'acme/handbook', allowMergeFromCms: false };
const REPO = '/repos/acme/handbook';

describe('checkEndpoint', () => {
  // R5: "The documented allowlist succeeds." Every row here is a call the editorial workflow
  // actually makes; if one is removed from the table, the endpoint that needs it stops working.
  describe('allows', () => {
    const cases: readonly [string, string, string][] = [
      ['GET', `${REPO}/git/ref/heads/main`, 'read a branch ref'],
      ['GET', `${REPO}/git/ref/heads/cms/pricing`, 'read a branch ref'],
      ['GET', `${REPO}/git/matching-refs/heads/cms/`, 'list matching branches'],
      ['GET', `${REPO}/git/trees/abc123?recursive=1`, 'read a tree'],
      ['GET', `${REPO}/git/blobs/abc123`, 'read a blob'],
      ['GET', `${REPO}/git/commits/abc123`, 'read a commit'],
      ['POST', `${REPO}/git/blobs`, 'create a blob'],
      ['POST', `${REPO}/git/trees`, 'create a tree'],
      ['POST', `${REPO}/git/commits`, 'create a commit'],
      ['POST', `${REPO}/git/refs`, 'create a branch'],
      ['PATCH', `${REPO}/git/refs/heads/cms/pricing`, 'move a branch'],
      ['DELETE', `${REPO}/git/refs/heads/cms/pricing`, 'delete a branch'],
      ['GET', `${REPO}/pulls?state=open`, 'list pull requests'],
      ['GET', `${REPO}/pulls/42`, 'read a pull request'],
      ['POST', `${REPO}/pulls`, 'open a pull request'],
      ['PATCH', `${REPO}/pulls/42`, 'update a pull request'],
    ];

    it.each(cases)('%s %s', (method, path, what) => {
      expect(checkEndpoint(method, path, OPTIONS)).toEqual({ ok: true, what });
    });
  });

  // R5: "Repository administration is refused: branch protection, collaborators, workflow
  // dispatch, webhooks, deploy keys." Asserted row by row, so an edit that widens the table has
  // to delete a test to land.
  describe('refuses repository administration', () => {
    const cases: readonly [string, string, string][] = [
      ['branch protection', 'PUT', `${REPO}/branches/main/protection`],
      ['rulesets', 'POST', `${REPO}/rulesets`],
      ['collaborators', 'PUT', `${REPO}/collaborators/mallory`],
      ['workflow dispatch', 'POST', `${REPO}/actions/workflows/publish.yml/dispatches`],
      ['actions secrets', 'PUT', `${REPO}/actions/secrets/AWS_PUBLISH_ROLE_ARN`],
      ['actions variables', 'POST', `${REPO}/actions/variables`],
      ['webhooks', 'POST', `${REPO}/hooks`],
      ['deploy keys', 'POST', `${REPO}/keys`],
      ['repository settings', 'PATCH', REPO],
      ['deleting the repository', 'DELETE', REPO],
      ['environments', 'PUT', `${REPO}/environments/publish`],
      ['contents, which would bypass the tree policy', 'PUT', `${REPO}/contents/docs/index.md`],
    ];

    it.each(cases)('%s', (_case, method, path) => {
      const result = checkEndpoint(method, path, OPTIONS);

      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ reason: 'not-allowlisted' });
    });
  });

  // R5: "An unmatched method/path combination is refused with 403 and logged." The method is half
  // of the key — a path being present for GET must not admit a DELETE.
  describe('refuses', () => {
    interface RefusalCase {
      readonly what: string;
      readonly method: string;
      readonly path: string;
      readonly reason: EndpointViolation;
    }

    const cases: readonly RefusalCase[] = [
      {
        what: 'a method the rule does not name',
        method: 'DELETE',
        path: `${REPO}/git/blobs`,
        reason: 'not-allowlisted',
      },
      {
        what: 'deleting a tag rather than a branch',
        method: 'DELETE',
        path: `${REPO}/git/refs/tags/v1`,
        reason: 'not-allowlisted',
      },
      {
        what: 'a pull request number that is not one',
        method: 'GET',
        path: `${REPO}/pulls/../secrets`,
        reason: 'not-allowlisted',
      },
      // Enumeration is admitted for branches under a prefix, not for the whole ref namespace. A
      // bare `heads/` would list every branch in the repository, which is not an editorial need.
      {
        what: 'listing every branch',
        method: 'GET',
        path: `${REPO}/git/matching-refs/heads/`,
        reason: 'not-allowlisted',
      },
      {
        what: 'listing tags rather than branches',
        method: 'GET',
        path: `${REPO}/git/matching-refs/tags/`,
        reason: 'not-allowlisted',
      },
      {
        what: 'another repository',
        method: 'POST',
        path: '/repos/acme/payroll/git/blobs',
        reason: 'other-repository',
      },
      {
        what: 'another owner',
        method: 'POST',
        path: '/repos/evil/handbook/git/blobs',
        reason: 'other-repository',
      },
      {
        what: 'a path outside any repository',
        method: 'GET',
        path: '/user',
        reason: 'not-a-repository-path',
      },
      {
        what: 'the organisation API',
        method: 'GET',
        path: '/orgs/acme/members',
        reason: 'not-a-repository-path',
      },
      { what: 'an empty path', method: 'GET', path: '', reason: 'not-a-repository-path' },
    ];

    it.each(cases)('$what', ({ method, path, reason }) => {
      const result = checkEndpoint(method, path, OPTIONS);

      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ reason });
    });
  });

  it('matches the repository case-insensitively, as the git host does', () => {
    expect(checkEndpoint('POST', '/repos/ACME/Handbook/git/blobs', OPTIONS)).toMatchObject({
      ok: true,
    });
  });

  it('accepts a lowercase method', () => {
    expect(checkEndpoint('post', `${REPO}/git/blobs`, OPTIONS)).toMatchObject({ ok: true });
  });

  // R7: "By default the gateway refuses merge requests from the CMS; approval happens in the git
  // host." R16 keeps the flag so moving approval into the CMS is configuration plus a UI.
  describe('merging', () => {
    it('is refused by default', () => {
      const result = checkEndpoint('PUT', `${REPO}/pulls/42/merge`, OPTIONS);

      expect(result.ok).toBe(false);
      expect(result).toMatchObject({
        message: expect.stringContaining('POLICY_ALLOW_MERGE_FROM_CMS') as unknown,
      });
    });

    it('is allowed once the policy flag is set', () => {
      expect(
        checkEndpoint('PUT', `${REPO}/pulls/42/merge`, { ...OPTIONS, allowMergeFromCms: true }),
      ).toEqual({ ok: true, what: 'merge a pull request' });
    });
  });
});
