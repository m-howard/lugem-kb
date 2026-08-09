import * as aws from '@pulumi/aws';
import * as github from '@pulumi/github';
import * as pulumi from '@pulumi/pulumi';

import { CmsCredential } from './src/components/cms-credential';
import { CorpusBucket } from './src/components/corpus-bucket';
import { CorpusRepository } from './src/components/corpus-repository';
import { DocsKnowledgeBase } from './src/components/docs-knowledge-base';
import { GatewayImage } from './src/components/gateway-image';
import { GatewayIngress } from './src/components/gateway-ingress';
import { GatewayService } from './src/components/gateway-service';
import { PublishPipeline } from './src/components/publish-pipeline';
import { resolveNetwork } from './src/network';
import { readGithubConfig, readStackConfig } from './src/read-config';

const NAME = `lugem-kb-${pulumi.getStack()}`;

const config = readStackConfig();
const githubConfig = readGithubConfig();

/**
 * One explicit provider rather than the ambient default: it pins the region to the value the
 * configuration was validated against, and it is the only place default tags can be set so that
 * every resource carries them without thirty individual `tags:` blocks.
 */
const awsProvider = new aws.Provider('aws', {
  region: config.region,
  defaultTags: {
    tags: { Project: 'lugem-kb', Stack: pulumi.getStack(), ManagedBy: 'pulumi' },
  },
});

const onAws: pulumi.ComponentResourceOptions = { providers: [awsProvider] };

const network = resolveNetwork(config, { provider: awsProvider });

// Provider-scoped for the same reason the network lookups are: an ambient invoke would resolve
// against a different region than the resources that consume it. Only the answer model's
// inference-profile ARN needs it.
const accountId = aws.getCallerIdentityOutput({}, { provider: awsProvider }).accountId;

const corpus = new CorpusBucket(NAME, onAws);

const knowledgeBase = new DocsKnowledgeBase(
  NAME,
  { config, corpusBucketArn: corpus.bucketArn },
  onAws,
);

// The GitHub half is opt-in: it needs an admin token the AWS half does not, and a stack that
// manages no repository is a supported configuration rather than a half-finished one.
let corpusRepository: CorpusRepository | undefined;
let publishPipeline: PublishPipeline | undefined;
let cmsCredential: CmsCredential | undefined;

if (githubConfig !== undefined) {
  const githubProvider = new github.Provider('github', { owner: githubConfig.owner });
  const onBoth: pulumi.ComponentResourceOptions = { providers: [awsProvider, githubProvider] };

  corpusRepository = new CorpusRepository(
    NAME,
    { config: githubConfig },
    { providers: [githubProvider] },
  );

  publishPipeline = new PublishPipeline(
    NAME,
    {
      config,
      githubConfig,
      repositoryName: corpusRepository.name,
      corpusBucketName: corpus.bucketName,
      corpusBucketArn: corpus.bucketArn,
      knowledgeBaseArn: knowledgeBase.knowledgeBaseArn,
      knowledgeBaseId: knowledgeBase.knowledgeBaseId,
      dataSourceId: knowledgeBase.dataSourceId,
    },
    onBoth,
  );

  if (githubConfig.cmsApp !== undefined) {
    cmsCredential = new CmsCredential(
      NAME,
      { app: githubConfig.cmsApp, repositoryName: corpusRepository.name },
      onBoth,
    );
  }
}

const image = new GatewayImage(NAME, onAws);

// The client secret is read here rather than in `github-config.ts` so it stays a Pulumi secret,
// encrypted in state. `requireSecret` fails the preview naming the key when it is absent, which is
// the same fail-closed behaviour the rest of the CMS configuration has.
const cmsOidc = githubConfig?.cmsGateway?.oidcListener;
const cmsAuth =
  cmsOidc === undefined
    ? undefined
    : { oidc: cmsOidc, clientSecret: new pulumi.Config().requireSecret('cmsOidcClientSecret') };

// The editorial target group exists whenever the CMS does, independently of how authors
// authenticate: `/readyz` gating editorial admission is about the credential, not the login.
const cmsEnabled = githubConfig?.cmsApp !== undefined && cmsCredential !== undefined;

const ingress = new GatewayIngress(
  NAME,
  { config, network, cmsEnabled, ...(cmsAuth === undefined ? {} : { cmsAuth }) },
  onAws,
);

// The editorial routes are mounted only when all three are present: the App ids, the gateway
// settings, and the secret the private key lives in. Passing a partial set would produce a task
// that boots and refuses the first author — see `resolveCmsConfig` in apps/gateway/src/config.ts.
const cms =
  githubConfig?.cmsApp === undefined ||
  githubConfig.cmsGateway === undefined ||
  corpusRepository === undefined ||
  cmsCredential === undefined
    ? undefined
    : {
        app: githubConfig.cmsApp,
        gateway: githubConfig.cmsGateway,
        repository: corpusRepository.fullName,
        defaultBranch: githubConfig.defaultBranch,
        loadBalancerArn: ingress.loadBalancerArn,
      };

const service = new GatewayService(
  NAME,
  {
    config,
    network,
    albSecurityGroupId: ingress.albSecurityGroupId,
    targetGroupArn: ingress.targetGroupArn,
    imageUri: image.imageUri,
    corpusBucketName: corpus.bucketName,
    corpusBucketArn: corpus.bucketArn,
    knowledgeBaseId: knowledgeBase.knowledgeBaseId,
    knowledgeBaseArn: knowledgeBase.knowledgeBaseArn,
    accountId,
    ...(cmsCredential === undefined ? {} : { cmsSecretArn: cmsCredential.secretArn }),
    ...(cms === undefined ? {} : { cms }),
    ...(ingress.cmsTargetGroupArn === undefined
      ? {}
      : { cmsTargetGroupArn: ingress.cmsTargetGroupArn }),
  },
  onAws,
);

export const siteUrl = ingress.url;
export const corpusBucketName = corpus.bucketName;
export const knowledgeBaseId = knowledgeBase.knowledgeBaseId;
export const dataSourceId = knowledgeBase.dataSourceId;
export const vectorBucketName = knowledgeBase.vectorBucketName;
export const ecrRepositoryUrl = image.repositoryUrl;
export const clusterName = service.clusterName;
export const serviceName = service.serviceName;
export const logGroupName = service.logGroupName;

// Undefined unless the GitHub half is configured. `pulumi stack output` simply omits them.
export const corpusRepositoryFullName = corpusRepository?.fullName;
export const publishRoleArn = publishPipeline?.roleArn;
export const cmsAppSecretArn = cmsCredential?.secretArn;
