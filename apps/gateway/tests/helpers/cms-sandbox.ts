import { generateKeyPair } from 'jose';

import { type FakeGitHost, fakeGitHost } from './fake-git-host';
import { type RepoState, type SeedFile } from './git-repo';
import { type SandboxAuthor, createSandboxIdp, type SandboxIdp } from './sandbox-idp';
import { createBearerVerifier } from '../../src/auth/bearer-verifier';
import { type CmsDependencies } from '../../src/cms/dependencies';
import { DocumentReader } from '../../src/cms/documents';
import { DraftService } from '../../src/cms/drafts';
import { MediaService } from '../../src/cms/media';
import { type CmsSettings } from '../../src/cms/settings';
import { SubmissionService } from '../../src/cms/submissions';
import { GitHubClient } from '../../src/git/github-client';
import { InstallationTokenSource } from '../../src/git/installation-token';

/**
 * The editorial half of the local sandbox: a live git host, and an identity provider to sign in
 * against.
 *
 * The gateway's editorial surface is mounted only when a GitHub App and an OIDC issuer are
 * configured, which makes `/publisher` unreachable locally without production credentials. This
 * assembles the same `CmsDependencies` production assembles, over collaborators that need neither.
 *
 * `createCmsDependencies` is deliberately not reused. It constructs its own `GitHubClient` with no
 * `fetch` seam, and adding one would put a knob in production wiring that only development turns —
 * so this composes the same services directly, the way `tests/helpers/e2e-cms.ts` already does.
 * The services themselves, and every policy inside them, are the production ones.
 *
 * It lives here rather than beside its caller in `scripts/dev/` for the reason `serve-e2e.ts`
 * records: runtime dependencies resolve from the workspace that declares them, and `jose` and
 * `hono` are the gateway's. Reading and writing the corpus needs neither, so that half stays in
 * `scripts/dev/` where a maintenance script belongs.
 */

const SANDBOX_REPOSITORY = 'lugem/sandbox-handbook';
const SANDBOX_AUDIENCE = 'lugem-cms';
const SANDBOX_CLIENT_ID = 'lugem-cms-admin';
const GITHUB_API = 'https://api.github.sandbox';
const IDP_MOUNT_PATH = '/idp';
const MAX_UPLOAD_BYTES = 2_097_152;

export interface CmsSandboxOptions {
  /** The corpus to start from. Ignored when `state` is present. */
  readonly seed?: Readonly<Record<string, SeedFile>>;
  /** A repository saved by an earlier run, so drafts survive a restart. */
  readonly state?: RepoState | undefined;
  /**
   * Whether the editor may merge its own submissions. `true` here and `false` in production: a
   * sandbox with no reviewer in it should still let you see what publishing does.
   */
  readonly allowMergeFromCms?: boolean;
  readonly author?: { email: string; name: string };
}

export interface CmsSandbox {
  readonly dependencies: CmsDependencies;
  readonly idp: SandboxIdp;
  readonly host: FakeGitHost;
  readonly settings: CmsSettings;
  /** Who the identity provider signs anyone in as, for the start-up banner. */
  readonly author: SandboxAuthor;
}

/**
 * Builds the sandbox's editorial dependencies.
 *
 * @param options - The corpus or saved state, and who is signed in.
 * @returns The CMS dependencies, the identity provider, and the live repository.
 */
export async function createCmsSandbox(options: CmsSandboxOptions): Promise<CmsSandbox> {
  const settings: CmsSettings = {
    repository: SANDBOX_REPOSITORY,
    defaultBranch: 'main',
    branchPrefix: 'cms/',
    pathPrefixes: ['docs/'],
    // Inside `pathPrefixes`, which the real config validates at start-up — see ADR 0021.
    mediaFolder: 'docs/assets/media/',
    maxUploadBytes: MAX_UPLOAD_BYTES,
  };

  const host = fakeGitHost({
    repository: settings.repository,
    defaultBranch: settings.defaultBranch,
    ...(options.state === undefined ? { seed: options.seed ?? {} } : { state: options.state }),
  });

  const author: SandboxAuthor = {
    subject: 'sandbox-author',
    email: options.author?.email ?? 'you@example.com',
    name: options.author?.name ?? 'Local Author',
  };
  const idp = await createSandboxIdp({
    mountPath: IDP_MOUNT_PATH,
    audience: SANDBOX_AUDIENCE,
    author,
  });

  // A throwaway key pair rather than a PEM on disk: the sandbox git host mints a token for any
  // signature, so a key that never leaves this process is one less file to explain or protect.
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const allowMerge = options.allowMergeFromCms ?? true;

  const tokens = new InstallationTokenSource({
    appId: '123456',
    installationId: '78901234',
    loadPrivateKey: () => Promise.resolve(privateKey),
    apiBaseUrl: GITHUB_API,
    fetch: host.fetch,
  });
  const client = new GitHubClient({
    tokens,
    repository: settings.repository,
    apiBaseUrl: GITHUB_API,
    allowMergeFromCms: allowMerge,
    fetch: host.fetch,
  });

  return {
    idp,
    host,
    settings,
    author,
    dependencies: {
      settings,
      tokens,
      client,
      reader: new DocumentReader({ client, settings }),
      drafts: new DraftService({ client, settings }),
      media: new MediaService({ client, settings }),
      submissions: new SubmissionService({ client, settings, allowMerge }),
      // The production verifier over a local key set: a bad token is genuinely refused here, so
      // the 401 paths behave locally exactly as they do deployed.
      verifier: createBearerVerifier({
        issuer: idp.issuer,
        audience: idp.audience,
        claimNames: { email: 'email', name: 'name' },
        keyResolver: idp.keyResolver,
      }),
      auth: {
        mode: 'bearer',
        issuer: idp.issuer,
        audience: idp.audience,
        clientId: SANDBOX_CLIENT_ID,
        emailClaim: 'email',
        nameClaim: 'name',
      },
      allowMergeFromCms: allowMerge,
      // No preview bucket in the sandbox, so the workflow card offers no preview link — the same
      // shape as a deployment that has not configured R12.
      previewBaseUrl: undefined,
    },
  };
}
