import * as pulumi from '@pulumi/pulumi';

import { type StackConfig, validateStackConfig } from './config';
import { type GithubConfig, validateGithubConfig } from './github-config';

/**
 * Reads and validates stack configuration from the Pulumi engine.
 *
 * The thin half of the config module: everything that can be decided without a Pulumi runtime
 * lives in {@link validateStackConfig}, which is why this file has no tests and needs none.
 *
 * @returns Validated stack configuration.
 * @throws {import('./config').StackConfigError} When configuration is unusable.
 */
export function readStackConfig(): StackConfig {
  const config = new pulumi.Config();
  const aws = new pulumi.Config('aws');

  return validateStackConfig({
    region: aws.get('region'),
    vpcId: config.get('vpcId'),
    privateSubnetIds: config.getObject<string[]>('privateSubnetIds'),
    publicSubnetIds: config.getObject<string[]>('publicSubnetIds'),
    albScheme: config.get('albScheme'),
    certificateArn: config.get('certificateArn'),
    desiredCount: config.getNumber('desiredCount'),
    cpu: config.getNumber('cpu'),
    memory: config.getNumber('memory'),
    logRetentionDays: config.getNumber('logRetentionDays'),
    embeddingModelId: config.get('embeddingModelId'),
    corpusPrefix: config.get('corpusPrefix'),
    containerPort: config.getNumber('containerPort'),
    allowUnverifiedRegion: config.getBoolean('allowUnverifiedRegion'),
    answerModelId: config.get('answerModelId'),
    answerModelRegions: config.getObject<string[]>('answerModelRegions'),
    answerMaxTokens: config.getNumber('answerMaxTokens'),
    askRateLimitPerMinute: config.getNumber('askRateLimitPerMinute'),
    retrievalScoreThreshold: config.getNumber('retrievalScoreThreshold'),
    gapFeedbackRetentionDays: config.getNumber('gapFeedbackRetentionDays'),
    readerAuthRequired: config.getBoolean('readerAuthRequired'),
  });
}

/**
 * Reads and validates the configuration for the repository backing the knowledge base.
 *
 * The thin half of {@link validateGithubConfig}, and untested for the same reason
 * {@link readStackConfig} is: there is nothing here a test could assert that the Pulumi engine
 * does not already guarantee.
 *
 * @returns Validated GitHub configuration, or `undefined` when `corpusRepository` is unset.
 * @throws {import('./config').StackConfigError} When configuration is unusable.
 */
export function readGithubConfig(): GithubConfig | undefined {
  const config = new pulumi.Config();

  return validateGithubConfig({
    corpusRepository: config.get('corpusRepository'),
    corpusRepositoryDescription: config.get('corpusRepositoryDescription'),
    corpusDefaultBranch: config.get('corpusDefaultBranch'),
    corpusRepositoryCreate: config.getBoolean('corpusRepositoryCreate'),
    corpusRepositoryImportId: config.get('corpusRepositoryImportId'),
    requiredStatusChecks: config.getObject<string[]>('requiredStatusChecks'),
    githubOidcProviderArn: config.get('githubOidcProviderArn'),
    cmsGitHubAppId: config.get('cmsGitHubAppId'),
    cmsGitHubAppInstallationId: config.get('cmsGitHubAppInstallationId'),
    cmsAuthMode: config.get('cmsAuthMode'),
    cmsAuthIssuerUrl: config.get('cmsAuthIssuerUrl'),
    cmsAuthAudience: config.get('cmsAuthAudience'),
    cmsAuthEmailClaim: config.get('cmsAuthEmailClaim'),
    cmsAuthNameClaim: config.get('cmsAuthNameClaim'),
    cmsBranchPrefix: config.get('cmsBranchPrefix'),
    cmsPathPrefixes: config.getObject<string[]>('cmsPathPrefixes'),
    cmsAllowMerge: config.getBoolean('cmsAllowMerge'),
    cmsOidcIssuer: config.get('cmsOidcIssuer'),
    cmsOidcAuthorizationEndpoint: config.get('cmsOidcAuthorizationEndpoint'),
    cmsOidcTokenEndpoint: config.get('cmsOidcTokenEndpoint'),
    cmsOidcUserInfoEndpoint: config.get('cmsOidcUserInfoEndpoint'),
    cmsOidcClientId: config.get('cmsOidcClientId'),
    // Read from the AWS half so `cmsAuthMode: alb` can be refused without a certificate. Both
    // readers see the same `pulumi.Config`, so they cannot disagree about its value.
    certificateArn: config.get('certificateArn'),
    readerAuthRequired: config.getBoolean('readerAuthRequired'),
  });
}
