import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

import { DocumentReader } from './documents';
import { DraftService } from './drafts';
import { type CmsSettings } from './settings';
import { SubmissionService } from './submissions';
import { createAlbVerifier } from '../auth/alb-verifier';
import { createBearerVerifier } from '../auth/bearer-verifier';
import { type IdentityVerifier } from '../auth/verifier';
import { type AuthConfig, type CmsConfig } from '../config';
import { createAppKeyLoader } from '../git/app-key';
import { GitHubClient } from '../git/github-client';
import { InstallationTokenSource } from '../git/installation-token';

/** Everything the editorial routes need, plus the credential the readiness probe checks. */
export interface CmsDependencies {
  readonly reader: DocumentReader;
  readonly drafts: DraftService;
  readonly submissions: SubmissionService;
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
}

/**
 * Builds the verifier for the configured mode (requirements.md R1; ADR 0013).
 *
 * The two modes are chosen here and nowhere else, so the rest of the service is written against
 * one interface and never learns which is deployed.
 *
 * @param auth - The resolved auth configuration.
 * @param region - Region of the load balancer, used only in `alb` mode.
 * @returns The verifier.
 */
export function createVerifier(auth: AuthConfig, region: string): IdentityVerifier {
  const claimNames = { email: auth.emailClaim, name: auth.nameClaim };

  if (auth.mode === 'alb') {
    return createAlbVerifier({ region, loadBalancerArn: auth.loadBalancerArn, claimNames });
  }
  return createBearerVerifier({ issuer: auth.issuer, audience: auth.audience, claimNames });
}

/**
 * Assembles the CMS collaborators from configuration, constructing real AWS and HTTP clients.
 *
 * Separated from the routes for the same reason `createDependencies` is separated from
 * `createApp`: tests supply fakes without the HTTP surface knowing whether its collaborators talk
 * to AWS and GitHub.
 *
 * @param cms - The CMS block of the configuration.
 * @param region - AWS region, for Secrets Manager and for ALB key lookups.
 * @returns The dependencies the editorial routes and the readiness probe need.
 */
export function createCmsDependencies(cms: CmsConfig, region: string): CmsDependencies {
  const settings: CmsSettings = {
    repository: cms.repository,
    defaultBranch: cms.defaultBranch,
    branchPrefix: cms.branchPrefix,
    pathPrefixes: cms.pathPrefixes,
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
    auth: cms.auth,
    reader: new DocumentReader({ client, settings }),
    drafts: new DraftService({ client, settings }),
    submissions: new SubmissionService({ client, settings, allowMerge: cms.allowMergeFromCms }),
    verifier: createVerifier(cms.auth, region),
    allowMergeFromCms: cms.allowMergeFromCms,
  };
}
