import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

import { DocumentReader } from './documents';
import { DraftService } from './drafts';
import { MediaService } from './media';
import { type CmsSettings } from './settings';
import { SubmissionService } from './submissions';
import { type IdentityVerifier } from '../auth/verifier';
import { type AuthConfig, type CmsConfig } from '../config';
import { createAppKeyLoader } from '../git/app-key';
import { GitHubClient } from '../git/github-client';
import { InstallationTokenSource } from '../git/installation-token';

export interface CmsDependencyOptions {
  readonly cms: CmsConfig;
  /** AWS region, for Secrets Manager. */
  readonly region: string;
  /** Built once by `createDependencies` and shared with the reader routes — see ADR 0017. */
  readonly verifier: IdentityVerifier;
  /**
   * The resolved auth configuration, published (never the verifier) so `/v1/admin/config` can
   * tell the admin page how to sign in. Auth was lifted out of `CmsConfig` by ADR 0017, so it is
   * `createDependencies` that resolves it now, from the same config the verifier is built from.
   */
  readonly auth: AuthConfig;
  /**
   * Where pull request previews are served from (requirements.md R12), when previews are
   * configured. Carried here so the editorial routes can hand it to the Decap adapter.
   */
  readonly previewBaseUrl?: string | undefined;
}

/** Everything the editorial routes need, plus the credential the readiness probe checks. */
export interface CmsDependencies {
  readonly reader: DocumentReader;
  readonly drafts: DraftService;
  readonly submissions: SubmissionService;
  /** Reads uploaded images — requirements.md R15. Writes go through `drafts`, with the page. */
  readonly media: MediaService;
  readonly settings: CmsSettings;
  readonly verifier: IdentityVerifier;
  readonly tokens: InstallationTokenSource;
  readonly allowMergeFromCms: boolean;
  /**
   * The allowlisted git client itself, for the one editorial read no service expresses: listing
   * the draft branches the editorial board is built from. Everything else goes through a service.
   */
  readonly client: GitHubClient;
  /**
   * The resolved auth configuration, so `/v1/admin/config` can tell the admin page how to sign in.
   * The verifier is built from the same block and remains the only thing that decides who someone
   * is — this is published for the browser's benefit, and grants nothing.
   */
  readonly auth: AuthConfig;
  /** Base URL for pull request previews, absent when none are configured. See ADR 0018. */
  readonly previewBaseUrl: string | undefined;
}

/**
 * Assembles the CMS collaborators from configuration, constructing real AWS and HTTP clients.
 *
 * Separated from the routes for the same reason `createDependencies` is separated from
 * `createApp`: tests supply fakes without the HTTP surface knowing whether its collaborators talk
 * to AWS and GitHub.
 *
 * The verifier is passed in rather than built here. Since R22 it is also what authenticates
 * readers, and one service must not end up with two of them disagreeing about who is calling.
 *
 * @param options - The CMS configuration block, the region, and the identity verifier.
 * @returns The dependencies the editorial routes and the readiness probe need.
 */
export function createCmsDependencies(options: CmsDependencyOptions): CmsDependencies {
  const { cms, region, verifier, auth, previewBaseUrl } = options;
  const settings: CmsSettings = {
    repository: cms.repository,
    defaultBranch: cms.defaultBranch,
    branchPrefix: cms.branchPrefix,
    pathPrefixes: cms.pathPrefixes,
    mediaFolder: cms.mediaFolder,
    maxUploadBytes: cms.maxUploadBytes,
  };

  const tokens = new InstallationTokenSource({
    appId: cms.appId,
    installationId: cms.installationId,
    apiBaseUrl: cms.apiBaseUrl,
    loadPrivateKey: createAppKeyLoader({
      secretArn: cms.secretArn,
      privateKeyPath: cms.privateKeyPath,
      secrets: cms.secretArn === undefined ? undefined : new SecretsManagerClient({ region }),
    }),
  });

  const client = new GitHubClient({
    tokens,
    repository: cms.repository,
    apiBaseUrl: cms.apiBaseUrl,
    allowMergeFromCms: cms.allowMergeFromCms,
  });

  return {
    settings,
    tokens,
    client,
    auth,
    previewBaseUrl,
    reader: new DocumentReader({ client, settings }),
    drafts: new DraftService({ client, settings }),
    media: new MediaService({ client, settings }),
    submissions: new SubmissionService({ client, settings, allowMerge: cms.allowMergeFromCms }),
    verifier,
    allowMergeFromCms: cms.allowMergeFromCms,
  };
}
