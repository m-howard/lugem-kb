import * as aws from '@pulumi/aws';
import * as github from '@pulumi/github';
import * as pulumi from '@pulumi/pulumi';

import { type StackConfig } from '../config';
import { type GithubConfig } from '../github-config';

const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com';
const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';
const STS_AUDIENCE = 'sts.amazonaws.com';

/** The GitHub deployment environment the publish workflow runs in, and the OIDC subject it claims. */
export const PUBLISH_ENVIRONMENT = 'publish';

export interface PublishPipelineArgs {
  readonly config: StackConfig;
  readonly githubConfig: GithubConfig;
  readonly repositoryName: pulumi.Input<string>;
  readonly corpusBucketName: pulumi.Output<string>;
  readonly corpusBucketArn: pulumi.Output<string>;
  readonly knowledgeBaseArn: pulumi.Output<string>;
  readonly knowledgeBaseId: pulumi.Output<string>;
  readonly dataSourceId: pulumi.Output<string>;
}

/**
 * The credential path and the configuration that let a merge publish the corpus.
 *
 * requirements.md R11 says merging the default branch syncs markdown to S3 and triggers ingestion,
 * and R21 says only default-branch content is ever indexed. Both are enforced here rather than
 * documented: the role can only be assumed from the `publish` environment, and that environment
 * only accepts protected branches.
 *
 * The six Actions variables are the point of keeping this in the same stack as the bucket and the
 * knowledge base. `scripts/docs/sync-corpus.ts` requires `CORPUS_BUCKET`, `CORPUS_PREFIX`,
 * `KNOWLEDGE_BASE_ID` and `DATA_SOURCE_ID`; every one is a stack output, and copying them into
 * GitHub by hand is a step that silently rots the first time a stack is rebuilt.
 *
 * @example
 * ```ts
 * const pipeline = new PublishPipeline('lugem-kb-dev', { config, githubConfig, ...wiring });
 * ```
 */
export class PublishPipeline extends pulumi.ComponentResource {
  public readonly roleArn: pulumi.Output<string>;
  public readonly environment: string;
  /**
   * The GitHub identity provider, exposed so a sibling component can reuse it.
   *
   * An account holds at most one per URL. A second component calling `resolveOidcProvider` for
   * itself would pass `pulumi preview` and then fail at apply — and only in accounts that did not
   * already have one, which is the worst way to find out. Passing this along makes the duplicate
   * structurally impossible.
   */
  public readonly oidcProviderArn: pulumi.Output<string>;

  constructor(name: string, args: PublishPipelineArgs, opts?: pulumi.ComponentResourceOptions) {
    super('lugem:github:PublishPipeline', name, {}, opts);

    this.oidcProviderArn = this.resolveOidcProvider(name, args.githubConfig);
    const role = this.createRole(name, args);
    this.createPolicy(name, args, role);

    new github.RepositoryEnvironment(
      `${name}-publish-environment`,
      {
        repository: args.repositoryName,
        environment: PUBLISH_ENVIRONMENT,
        canAdminsBypass: false,
        deploymentBranchPolicy: { protectedBranches: true, customBranchPolicies: false },
      },
      { parent: this },
    );

    this.publishVariables(name, args, role.arn);

    this.roleArn = role.arn;
    this.environment = PUBLISH_ENVIRONMENT;

    this.registerOutputs({
      roleArn: this.roleArn,
      environment: this.environment,
      oidcProviderArn: this.oidcProviderArn,
    });
  }

  /**
   * The role GitHub Actions assumes, trusted for exactly one repository and one environment.
   *
   * The subject is `environment:`-scoped rather than `ref:`-scoped. Both would pin the default
   * branch, but the environment form also means a workflow that skips the deployment gate cannot
   * assume the role at all, whatever ref it runs on.
   */
  private createRole(name: string, args: PublishPipelineArgs): aws.iam.Role {
    const providerArn = this.oidcProviderArn;
    const subject = `repo:${args.githubConfig.fullName}:environment:${PUBLISH_ENVIRONMENT}`;

    return new aws.iam.Role(
      `${name}-publish-role`,
      {
        description: 'GitHub Actions syncs the corpus to S3 and starts Bedrock ingestion',
        assumeRolePolicy: providerArn.apply((arn) =>
          JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Principal: { Federated: arn },
                Action: 'sts:AssumeRoleWithWebIdentity',
                Condition: {
                  StringEquals: {
                    [`${GITHUB_OIDC_HOST}:aud`]: STS_AUDIENCE,
                    [`${GITHUB_OIDC_HOST}:sub`]: subject,
                  },
                },
              },
            ],
          }),
        ),
      },
      { parent: this },
    );
  }

  /**
   * An account holds at most one identity provider per URL, and most accounts that already use
   * GitHub Actions have it. Creating a second would fail; assuming one exists would fail differently.
   */
  private resolveOidcProvider(name: string, config: GithubConfig): pulumi.Output<string> {
    if (config.oidcProviderArn !== undefined) {
      return pulumi.output(config.oidcProviderArn);
    }

    const provider = new aws.iam.OpenIdConnectProvider(
      `${name}-github-oidc`,
      // No thumbprintLists: AWS validates GitHub's certificate against its own trusted roots, and a
      // pinned thumbprint is one more thing to rotate for no security gained.
      { url: GITHUB_OIDC_URL, clientIdLists: [STS_AUDIENCE] },
      { parent: this },
    );
    return provider.arn;
  }

  /** Exactly the calls `scripts/docs/sync-corpus.ts` makes, on exactly one prefix. */
  private createPolicy(name: string, args: PublishPipelineArgs, role: aws.iam.Role): void {
    const { corpusPrefix } = args.config;

    new aws.iam.RolePolicy(
      `${name}-publish-policy`,
      {
        role: role.id,
        policy: pulumi
          .all([args.corpusBucketArn, args.knowledgeBaseArn])
          .apply(([bucketArn, knowledgeBaseArn]) =>
            JSON.stringify({
              Version: '2012-10-17',
              Statement: [
                {
                  Sid: 'ListCorpusPrefixOnly',
                  Effect: 'Allow',
                  Action: ['s3:ListBucket'],
                  Resource: [bucketArn],
                  Condition: { StringLike: { 's3:prefix': [`${corpusPrefix}*`] } },
                },
                {
                  Sid: 'WriteCorpusPrefixOnly',
                  Effect: 'Allow',
                  Action: ['s3:PutObject', 's3:DeleteObject'],
                  Resource: [`${bucketArn}/${corpusPrefix}*`],
                },
                {
                  Sid: 'IngestOneKnowledgeBase',
                  Effect: 'Allow',
                  Action: ['bedrock:StartIngestionJob', 'bedrock:GetIngestionJob'],
                  Resource: [knowledgeBaseArn],
                },
              ],
            }),
          ),
      },
      { parent: this },
    );
  }

  /**
   * Repository variables rather than environment variables: the workflow's "is this configured"
   * gate has to read them from a job that has not entered the deployment environment yet.
   *
   * Variables rather than secrets: none of these are credentials, and a value hidden in a secret
   * cannot be read back when a publish run fails.
   */
  private publishVariables(
    name: string,
    args: PublishPipelineArgs,
    roleArn: pulumi.Output<string>,
  ): void {
    const variables: Record<string, pulumi.Input<string>> = {
      AWS_PUBLISH_ROLE_ARN: roleArn,
      AWS_REGION: args.config.region,
      CORPUS_BUCKET: args.corpusBucketName,
      CORPUS_PREFIX: args.config.corpusPrefix,
      KNOWLEDGE_BASE_ID: args.knowledgeBaseId,
      DATA_SOURCE_ID: args.dataSourceId,
    };

    for (const [variableName, value] of Object.entries(variables)) {
      const slug = variableName.toLowerCase().replace(/_/g, '-');
      new github.ActionsVariable(
        `${name}-var-${slug}`,
        { repository: args.repositoryName, variableName, value },
        { parent: this },
      );
    }
  }
}
