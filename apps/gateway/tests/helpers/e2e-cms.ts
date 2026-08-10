/**
 * The editorial half of the e2e server: a stub identity provider and a stub git host.
 *
 * Kept out of `serve-e2e.ts` because it is fixture data rather than wiring, and because the two
 * stubs have different jobs. The identity provider is reached **by the browser**, so it has to be
 * real HTTP on the same origin — that is the whole point of the `/admin` e2e, which exists to
 * prove the sign-in the unit tests can only exercise in pieces. The git host is reached by the
 * gateway, so it stays an injected `fetch`.
 */
import { Hono } from 'hono';
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';

import { fakeGitHub, type FakeGitHubRoute } from './fake-github';
import { createBearerVerifier } from '../../src/auth/bearer-verifier';
import { type CmsDependencies } from '../../src/cms/dependencies';
import { DocumentReader } from '../../src/cms/documents';
import { DraftService } from '../../src/cms/drafts';
import { type CmsSettings } from '../../src/cms/settings';
import { SubmissionService } from '../../src/cms/submissions';
import { GitHubClient } from '../../src/git/github-client';
import { InstallationTokenSource } from '../../src/git/installation-token';

const REPOSITORY = 'acme/handbook';
const GITHUB_API = 'https://api.github.test';
const REPO = `/repos/${REPOSITORY}`;
const KEY_ID = 'e2e-key-1';
const TOKEN_LIFETIME_SECONDS = 3600;
const MS_PER_SECOND = 1000;
const FOUND = 302;

const SETTINGS: CmsSettings = {
  repository: REPOSITORY,
  defaultBranch: 'main',
  branchPrefix: 'cms/',
  pathPrefixes: ['docs/'],
};

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** A corpus of one page, which is enough for the editor to list a collection and open an entry. */
const GIT_ROUTES: readonly FakeGitHubRoute[] = [
  {
    method: 'GET',
    path: `${REPO}/git/ref/heads/main`,
    respond: { object: { sha: 'commit-main' } },
  },
  {
    method: 'GET',
    path: `${REPO}/git/commits/commit-main`,
    respond: { tree: { sha: 'tree-main' }, committer: { date: '2026-08-10T09:00:00Z' } },
  },
  {
    method: 'GET',
    path: `${REPO}/git/trees/tree-main`,
    respond: {
      tree: [{ path: 'docs/leave-policy.md', type: 'blob', sha: 'blob-leave', size: 30 }],
    },
  },
  {
    method: 'GET',
    path: `${REPO}/git/blobs/blob-leave`,
    respond: {
      content: base64(
        '---\ntitle: Leave policy\nowner: people\nlast_reviewed: 2026-08-01\n---\n\nTake it.\n',
      ),
      encoding: 'base64',
    },
  },
  { method: 'GET', path: `${REPO}/git/matching-refs/heads/cms/`, respond: [] },
  { method: 'GET', path: `${REPO}/pulls`, respond: [] },
  {
    method: 'GET',
    path: /\/git\/ref\/heads\/cms\//,
    status: 404,
    respond: { message: 'Not Found' },
  },
  { method: 'POST', path: `${REPO}/git/blobs`, respond: { sha: 'blob-written' } },
  { method: 'POST', path: `${REPO}/git/trees`, respond: { sha: 'tree-written' } },
  { method: 'POST', path: `${REPO}/git/commits`, respond: { sha: 'commit-written' } },
  { method: 'POST', path: `${REPO}/git/refs`, respond: { ref: 'refs/heads/cms/docs/new-page' } },
];

export interface E2eCms {
  readonly dependencies: CmsDependencies;
  /** Mount at `/idp`. Reached by the browser, so it is real HTTP on the site's own origin. */
  readonly idp: Hono;
  /** Every call the gateway made at the stub git host, for a spec that wants to assert on one. */
  paths(): string[];
}

/**
 * Builds the CMS dependencies over stubs, plus the identity provider the browser signs in against.
 *
 * The verifier is the production `createBearerVerifier` with a local key set: the signature is
 * genuinely checked, so a spec that reached the adapter with a bad token would fail rather than
 * pass quietly. Only discovery is short-circuited, because the gateway fetching its own process
 * over HTTP to find a key it already has proves nothing.
 *
 * @param origin - Where this server is reachable, e.g. `http://127.0.0.1:4173`.
 * @returns The dependencies, the identity provider routes, and the recorded upstream calls.
 */
export async function createE2eCms(origin: string): Promise<E2eCms> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: KEY_ID, alg: 'RS256', use: 'sig' } as JWK;
  const issuer = `${origin}/idp`;
  const audience = 'lugem-cms';

  const host = fakeGitHub(GIT_ROUTES);
  const tokens = new InstallationTokenSource({
    appId: '123456',
    installationId: '78901234',
    loadPrivateKey: () => Promise.resolve(privateKey),
    apiBaseUrl: GITHUB_API,
    fetch: host.fetch,
  });
  const client = new GitHubClient({
    tokens,
    repository: REPOSITORY,
    apiBaseUrl: GITHUB_API,
    allowMergeFromCms: false,
    fetch: host.fetch,
  });

  const idp = new Hono();

  idp.get('/.well-known/openid-configuration', (c) =>
    c.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
    }),
  );
  idp.get('/jwks', (c) => c.json({ keys: [jwk] }));

  // No login form: the point of the spec is the redirect dance and the code exchange, not a
  // password box nobody here wrote.
  idp.get('/authorize', (c) => {
    const redirectUri = c.req.query('redirect_uri') ?? `${origin}/admin/`;
    const state = c.req.query('state') ?? '';
    const target = new URL(redirectUri);
    target.searchParams.set('code', 'e2e-authorization-code');
    target.searchParams.set('state', state);

    return c.redirect(target.toString(), FOUND);
  });

  idp.post('/token', async (c) => {
    const now = Math.floor(Date.now() / MS_PER_SECOND);
    const token = await new SignJWT({ sub: 'e2e-1', email: 'sam@example.com', name: 'Sam Okoro' })
      .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt(now)
      .setExpirationTime(now + TOKEN_LIFETIME_SECONDS)
      .sign(privateKey);

    return c.json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: TOKEN_LIFETIME_SECONDS,
    });
  });

  return {
    idp,
    paths: () => host.paths(),
    dependencies: {
      settings: SETTINGS,
      tokens,
      client,
      reader: new DocumentReader({ client, settings: SETTINGS }),
      drafts: new DraftService({ client, settings: SETTINGS }),
      submissions: new SubmissionService({ client, settings: SETTINGS, allowMerge: false }),
      verifier: createBearerVerifier({
        issuer,
        audience,
        claimNames: { email: 'email', name: 'name' },
        keyResolver: createLocalJWKSet({ keys: [jwk] }),
      }),
      auth: {
        mode: 'bearer',
        issuer,
        audience,
        clientId: 'lugem-cms-admin',
        emailClaim: 'email',
        nameClaim: 'name',
      },
      allowMergeFromCms: false,
      // The e2e stack has no preview bucket, so the workflow card offers no preview link — the
      // same shape as a deployment that has not configured R12.
      previewBaseUrl: undefined,
    },
  };
}
