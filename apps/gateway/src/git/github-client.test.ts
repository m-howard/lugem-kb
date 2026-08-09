import { generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';

import { EndpointPolicyError, GitHubClient, GitHubError } from './github-client';
import { InstallationTokenSource } from './installation-token';
import { fakeGitHub, type FakeGitHubRoute } from '../../tests/helpers/fake-github';

const API = 'https://api.github.test';
const REPOSITORY = 'acme/handbook';
const REPO_PATH = `/repos/${REPOSITORY}`;
const NOT_FOUND = 404;
const UNAUTHORIZED = 401;

async function clientOver(
  host: ReturnType<typeof fakeGitHub>,
  allowMergeFromCms = false,
): Promise<GitHubClient> {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  return new GitHubClient({
    tokens: new InstallationTokenSource({
      appId: '123456',
      installationId: '78901234',
      loadPrivateKey: () => Promise.resolve(privateKey),
      apiBaseUrl: API,
      fetch: host.fetch,
    }),
    repository: REPOSITORY,
    apiBaseUrl: API,
    allowMergeFromCms,
    fetch: host.fetch,
  });
}

const READ_A_BLOB: FakeGitHubRoute = {
  method: 'GET',
  path: `${REPO_PATH}/git/blobs/abc123`,
  respond: { sha: 'abc123', content: 'aGk=' },
};

describe('GitHubClient', () => {
  it('makes an allowlisted call and returns the parsed body', async () => {
    const host = fakeGitHub([READ_A_BLOB]);
    const client = await clientOver(host);

    const response = await client.request(`GET`, `${REPO_PATH}/git/blobs/abc123`);

    expect(response).toMatchObject({ status: 200, body: { sha: 'abc123' } });
  });

  // R2: no author credential ever reaches the git host. Every call carries the installation
  // token, and only the installation token.
  it('authenticates with the installation token', async () => {
    const host = fakeGitHub([READ_A_BLOB]);
    const client = await clientOver(host);

    await client.request('GET', `${REPO_PATH}/git/blobs/abc123`);

    const call = host.calls.find((candidate) => candidate.path.includes('/git/blobs/'));
    expect(call?.authorization).toBe('Bearer ghs_installation_token');
  });

  // R5: refusal happens before the upstream call, so a policy failure cannot partially apply.
  // The fake would throw on an unexpected call, but asserting on the recorded calls says plainly
  // that nothing was sent at all — not even the token mint.
  describe('refuses before sending anything', () => {
    const cases: readonly [string, string, string][] = [
      ['branch protection', 'PUT', `${REPO_PATH}/branches/main/protection`],
      ['a workflow dispatch', 'POST', `${REPO_PATH}/actions/workflows/publish.yml/dispatches`],
      ['another repository', 'POST', '/repos/acme/payroll/git/blobs'],
    ];

    it.each(cases)('%s', async (_case, method, path) => {
      const host = fakeGitHub();
      const client = await clientOver(host);

      await expect(client.request(method, path)).rejects.toBeInstanceOf(EndpointPolicyError);
      expect(host.calls).toEqual([]);
    });
  });

  it('carries the refusal reason, so the route can log and answer with it', async () => {
    const client = await clientOver(fakeGitHub());

    await expect(client.request('POST', '/repos/acme/payroll/git/blobs')).rejects.toMatchObject({
      reason: 'other-repository',
    });
  });

  it('sends a JSON body for the calls that take one', async () => {
    const host = fakeGitHub([
      { method: 'POST', path: `${REPO_PATH}/git/blobs`, respond: { sha: 'new' } },
    ]);
    const client = await clientOver(host);

    await client.request('POST', `${REPO_PATH}/git/blobs`, { content: 'hi', encoding: 'utf-8' });

    expect(host.calls.at(-1)?.body).toEqual({ content: 'hi', encoding: 'utf-8' });
  });

  describe('when the git host refuses', () => {
    it('throws with the upstream status and message', async () => {
      const host = fakeGitHub([
        {
          method: 'POST',
          path: `${REPO_PATH}/git/refs`,
          status: 422,
          respond: { message: 'Reference already exists' },
        },
      ]);
      const client = await clientOver(host);

      await expect(client.request('POST', `${REPO_PATH}/git/refs`, {})).rejects.toMatchObject({
        name: 'GitHubError',
        status: 422,
        message: 'Reference already exists',
      });
    });

    // R2: "A 401 from the git host invalidates the cache and retries once before surfacing an
    // error." Once — a revoked credential must surface, not become a retry loop.
    it('invalidates the token and retries exactly once on 401', async () => {
      let attempts = 0;
      const host = fakeGitHub([
        {
          method: 'GET',
          path: `${REPO_PATH}/git/blobs/abc123`,
          get status() {
            attempts += 1;
            return attempts === 1 ? UNAUTHORIZED : 200;
          },
          respond: { sha: 'abc123' },
        },
      ]);
      const client = await clientOver(host);

      const response = await client.request(`GET`, `${REPO_PATH}/git/blobs/abc123`);

      expect(response.body).toMatchObject({ sha: 'abc123' });
      expect(host.paths()).toEqual([
        `${REPO_PATH}/git/blobs/abc123`,
        `${REPO_PATH}/git/blobs/abc123`,
      ]);
      // Two mints: the first for the original call, the second after invalidation.
      expect(host.calls.filter((call) => call.path.startsWith('/app/'))).toHaveLength(2);
    });

    it('surfaces a persistent 401 rather than retrying forever', async () => {
      const host = fakeGitHub([
        {
          method: 'GET',
          path: `${REPO_PATH}/git/blobs/abc123`,
          status: UNAUTHORIZED,
          respond: { message: 'Bad credentials' },
        },
      ]);
      const client = await clientOver(host);

      await expect(client.request('GET', `${REPO_PATH}/git/blobs/abc123`)).rejects.toBeInstanceOf(
        GitHubError,
      );
      expect(host.paths()).toHaveLength(2);
    });
  });

  describe('getOrUndefined', () => {
    it('returns the body when the resource exists', async () => {
      const host = fakeGitHub([READ_A_BLOB]);
      const client = await clientOver(host);

      await expect(client.getOrUndefined(`${REPO_PATH}/git/blobs/abc123`)).resolves.toMatchObject({
        sha: 'abc123',
      });
    });

    // A draft branch that does not exist yet is the normal first step of creating one.
    it('returns undefined for a 404', async () => {
      const host = fakeGitHub([
        {
          method: 'GET',
          path: `${REPO_PATH}/git/ref/heads/cms/new`,
          status: NOT_FOUND,
          respond: { message: 'Not Found' },
        },
      ]);
      const client = await clientOver(host);

      await expect(
        client.getOrUndefined(`${REPO_PATH}/git/ref/heads/cms/new`),
      ).resolves.toBeUndefined();
    });

    it('still throws for a refusal that is not absence', async () => {
      const host = fakeGitHub([
        {
          method: 'GET',
          path: `${REPO_PATH}/git/ref/heads/cms/new`,
          status: 403,
          respond: { message: 'Forbidden' },
        },
      ]);
      const client = await clientOver(host);

      await expect(
        client.getOrUndefined(`${REPO_PATH}/git/ref/heads/cms/new`),
      ).rejects.toBeInstanceOf(GitHubError);
    });
  });
});
