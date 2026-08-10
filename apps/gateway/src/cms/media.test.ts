import { generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';

import { DocumentMissingError } from './documents';
import { CmsPolicyError } from './errors';
import { MediaService } from './media';
import { type CmsSettings } from './settings';
import { fakeGitHub, type FakeGitHubRoute } from '../../tests/helpers/fake-github';
import { GitHubClient } from '../git/github-client';
import { InstallationTokenSource } from '../git/installation-token';

const API = 'https://api.github.test';
const REPOSITORY = 'acme/handbook';
const MEDIA_FOLDER = 'docs/assets/media/';

const SETTINGS: CmsSettings = {
  repository: REPOSITORY,
  defaultBranch: 'main',
  branchPrefix: 'cms/',
  pathPrefixes: ['docs/'],
  mediaFolder: MEDIA_FOLDER,
  maxUploadBytes: 2_097_152,
};

/** A one-pixel PNG, base64 encoded — small enough to read in a diff, real enough to be a PNG. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAd8s6BwAAAABJRU5ErkJggg==';

async function serviceOver(host: ReturnType<typeof fakeGitHub>): Promise<MediaService> {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const client = new GitHubClient({
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

  return new MediaService({ client, settings: SETTINGS });
}

/** The three calls a tree read costs: the ref, its commit, and the tree itself. */
function branchRoutes(
  tree: readonly { path: string; sha: string; size?: number }[],
): FakeGitHubRoute[] {
  return [
    { method: 'GET', path: /\/git\/ref\/heads\//, respond: { object: { sha: 'commit-1' } } },
    { method: 'GET', path: /\/git\/commits\//, respond: { tree: { sha: 'tree-1' } } },
    {
      method: 'GET',
      path: /\/git\/trees\//,
      respond: { tree: tree.map((entry) => ({ ...entry, type: 'blob' })) },
    },
  ];
}

function blobRoute(content = PNG_BASE64): FakeGitHubRoute {
  return { method: 'GET', path: /\/git\/blobs\//, respond: { content, encoding: 'base64' } };
}

const TREE = [
  { path: 'docs/index.md', sha: 'blob-page' },
  { path: `${MEDIA_FOLDER}org-chart.png`, sha: 'blob-chart', size: 1234 },
  { path: `${MEDIA_FOLDER}hr/onboarding.webp`, sha: 'blob-onboarding', size: 99 },
  // Not media, whatever folder it sits in — the policy decides, not the location alone.
  { path: `${MEDIA_FOLDER}notes.md`, sha: 'blob-notes' },
  { path: `${MEDIA_FOLDER}diagram.svg`, sha: 'blob-svg' },
  // An image outside the media folder is somebody else's file, and not the CMS's to offer.
  { path: 'docs/guides/stray.png', sha: 'blob-stray' },
];

describe('MediaService.list', () => {
  it('returns only permitted images inside the media folder', async () => {
    const host = fakeGitHub(branchRoutes(TREE));

    await expect((await serviceOver(host)).list()).resolves.toEqual([
      { path: `${MEDIA_FOLDER}org-chart.png`, sha: 'blob-chart', size: 1234 },
      { path: `${MEDIA_FOLDER}hr/onboarding.webp`, sha: 'blob-onboarding', size: 99 },
    ]);
  });

  // Reading no blobs is the point: the editorial board asks what a draft changed on every refresh,
  // and answering that with a blob per screenshot would make the board cost more the more images
  // the corpus holds.
  it('reads no blobs', async () => {
    const host = fakeGitHub(branchRoutes(TREE));
    await (await serviceOver(host)).list();

    expect(host.paths().some((path) => path.includes('/git/blobs/'))).toBe(false);
  });

  it('answers with nothing when the branch does not exist', async () => {
    const host = fakeGitHub([
      { method: 'GET', path: /\/git\/ref\/heads\//, status: 404, respond: {} },
    ]);

    await expect((await serviceOver(host)).list('cms/guides/leave')).resolves.toEqual([]);
  });

  it('refuses a branch outside the CMS prefix', async () => {
    const host = fakeGitHub([]);

    await expect((await serviceOver(host)).list('release/2026')).rejects.toThrow(CmsPolicyError);
    expect(host.paths()).toEqual([]);
  });
});

describe('MediaService.listWithContent', () => {
  it('carries base64 content and the file name the author gave it', async () => {
    const host = fakeGitHub([...branchRoutes(TREE), blobRoute()]);

    await expect((await serviceOver(host)).listWithContent()).resolves.toEqual([
      {
        branch: 'main',
        path: `${MEDIA_FOLDER}org-chart.png`,
        name: 'org-chart.png',
        sha: 'blob-chart',
        size: 1234,
        content: PNG_BASE64,
      },
      {
        branch: 'main',
        path: `${MEDIA_FOLDER}hr/onboarding.webp`,
        name: 'onboarding.webp',
        sha: 'blob-onboarding',
        size: 99,
        content: PNG_BASE64,
      },
    ]);
  });
});

describe('MediaService.read', () => {
  it('reads one image from a draft branch', async () => {
    const host = fakeGitHub([...branchRoutes(TREE), blobRoute()]);

    await expect(
      (await serviceOver(host)).read(`${MEDIA_FOLDER}org-chart.png`, 'cms/guides/leave'),
    ).resolves.toMatchObject({
      branch: 'cms/guides/leave',
      name: 'org-chart.png',
      sha: 'blob-chart',
      content: PNG_BASE64,
    });
  });

  // The git host wraps base64 at 60 characters. Handing that to a browser's `atob` throws, which
  // surfaces as an image that silently fails to appear rather than as an error anybody can read.
  it('strips the line wrapping the git host adds to base64', async () => {
    const host = fakeGitHub([
      ...branchRoutes(TREE),
      blobRoute(`${PNG_BASE64.slice(0, 60)}\n${PNG_BASE64.slice(60)}\n`),
    ]);

    await expect(
      (await serviceOver(host)).read(`${MEDIA_FOLDER}org-chart.png`),
    ).resolves.toMatchObject({ content: PNG_BASE64 });
  });

  it('encodes a blob the host answered as utf8, rather than passing text through', async () => {
    const host = fakeGitHub([
      ...branchRoutes(TREE),
      { method: 'GET', path: /\/git\/blobs\//, respond: { content: 'hello', encoding: 'utf-8' } },
    ]);

    await expect(
      (await serviceOver(host)).read(`${MEDIA_FOLDER}org-chart.png`),
    ).resolves.toMatchObject({ content: Buffer.from('hello', 'utf8').toString('base64') });
  });

  it.each([
    ['markdown', `${MEDIA_FOLDER}notes.md`],
    ['an svg', `${MEDIA_FOLDER}diagram.svg`],
    ['an image outside the folder', 'docs/guides/stray.png'],
    ['traversal', `${MEDIA_FOLDER}../../../.github/x.png`],
  ])('refuses %s before any upstream call', async (_case, path) => {
    const host = fakeGitHub([]);

    await expect((await serviceOver(host)).read(path)).rejects.toThrow(CmsPolicyError);
    expect(host.paths()).toEqual([]);
  });

  it('reports a permitted path that is simply not there as missing', async () => {
    const host = fakeGitHub(branchRoutes(TREE));

    await expect((await serviceOver(host)).read(`${MEDIA_FOLDER}absent.png`)).rejects.toThrow(
      DocumentMissingError,
    );
  });

  it('reports a missing branch as a missing file', async () => {
    const host = fakeGitHub([
      { method: 'GET', path: /\/git\/ref\/heads\//, status: 404, respond: {} },
    ]);

    await expect(
      (await serviceOver(host)).read(`${MEDIA_FOLDER}org-chart.png`, 'cms/guides/leave'),
    ).rejects.toThrow(DocumentMissingError);
  });
});
