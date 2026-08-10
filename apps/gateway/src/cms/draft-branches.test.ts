import { generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';

import { listDraftBranches } from './draft-branches';
import { fakeGitHub, type FakeGitHubRoute } from '../../tests/helpers/fake-github';
import { GitHubClient } from '../git/github-client';
import { InstallationTokenSource } from '../git/installation-token';

const API = 'https://api.github.test';
const REPOSITORY = 'acme/handbook';
const MATCHING_REFS = `/repos/${REPOSITORY}/git/matching-refs/heads/cms/`;

async function clientOver(host: ReturnType<typeof fakeGitHub>): Promise<GitHubClient> {
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
    allowMergeFromCms: false,
    fetch: host.fetch,
  });
}

function refsRoute(respond: unknown): FakeGitHubRoute {
  return { method: 'GET', path: MATCHING_REFS, respond };
}

describe('listDraftBranches', () => {
  it('returns branch names without the refs/heads qualifier', async () => {
    const host = fakeGitHub([
      refsRoute([{ ref: 'refs/heads/cms/guides/leave-policy' }, { ref: 'refs/heads/cms/pricing' }]),
    ]);

    await expect(listDraftBranches(await clientOver(host), 'cms/')).resolves.toEqual([
      'cms/guides/leave-policy',
      'cms/pricing',
    ]);
  });

  it('answers with no drafts when nothing matches', async () => {
    const host = fakeGitHub([refsRoute([])]);

    await expect(listDraftBranches(await clientOver(host), 'cms/')).resolves.toEqual([]);
  });

  it('normalises a prefix supplied without a trailing slash', async () => {
    const host = fakeGitHub([refsRoute([{ ref: 'refs/heads/cms/pricing' }])]);

    await expect(listDraftBranches(await clientOver(host), 'cms')).resolves.toEqual([
      'cms/pricing',
    ]);
    expect(host.paths()).toEqual([MATCHING_REFS]);
  });

  // The git host matches refs as a string prefix, so this filter is what stops a sibling branch
  // being reported as a draft if the trailing slash ever went missing upstream.
  it('drops a ref that is outside the prefix', async () => {
    const host = fakeGitHub([
      refsRoute([{ ref: 'refs/heads/cms-internal/pricing' }, { ref: 'refs/heads/cms/pricing' }]),
    ]);

    await expect(listDraftBranches(await clientOver(host), 'cms/')).resolves.toEqual([
      'cms/pricing',
    ]);
  });

  it('drops a ref that is not a branch', async () => {
    const host = fakeGitHub([
      refsRoute([{ ref: 'refs/tags/v1' }, { ref: 'refs/heads/cms/pricing' }]),
    ]);

    await expect(listDraftBranches(await clientOver(host), 'cms/')).resolves.toEqual([
      'cms/pricing',
    ]);
  });

  it('tolerates a body that is not a list', async () => {
    const host = fakeGitHub([refsRoute({ message: 'Not Found' })]);

    await expect(listDraftBranches(await clientOver(host), 'cms/')).resolves.toEqual([]);
  });

  // An empty prefix would ask the git host to list every branch. The endpoint allowlist refuses
  // that call, so reaching it at all would be a policy error where "no drafts" is the honest
  // answer — and asserting no call left proves the refusal is not merely being caught.
  it('makes no upstream call for an empty prefix', async () => {
    const host = fakeGitHub([]);

    await expect(listDraftBranches(await clientOver(host), '')).resolves.toEqual([]);
    expect(host.paths()).toEqual([]);
  });
});
