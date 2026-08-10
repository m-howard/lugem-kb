import * as aws from '@pulumi/aws';
import * as github from '@pulumi/github';
import * as pulumi from '@pulumi/pulumi';

import { type StackConfig } from '../config';
import { type GithubConfig } from '../github-config';

const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';
const STS_AUDIENCE = 'sts.amazonaws.com';

/** The GitHub deployment environment the gap report runs in, and the OIDC subject it claims. */
export const GAP_REPORT_ENVIRONMENT = 'gap-report';

export interface GapReportPipelineArgs {
  readonly config: StackConfig;
  readonly githubConfig: GithubConfig;
  readonly repositoryName: pulumi.Input<string>;
  readonly gapFeedbackTableName: pulumi.Output<string>;
  readonly gapFeedbackTableArn: pulumi.Output<string>;
  /** Taken from `PublishPipeline`, because an account holds at most one provider per URL. */
  readonly oidcProviderArn: pulumi.Output<string>;
}

/**
 * The credential path that lets the scheduled report read documentation gaps and file them.
 *
 * **A separate role from the publish pipeline, deliberately.** `PublishPipeline`'s policy is
 * documented as "exactly the calls `sync-corpus.ts` makes"; widening it with `dynamodb:Query`
 * would hand the corpus-publishing path read access to reader question text, which is the most
 * sensitive data in the system. Two roles, two environments, two reasons to exist.
 *
 * The split is the other half of a promise made in `gateway-service.ts`: the gateway can write
 * gaps and never read them, and this role can read them and never write. Neither can do the
 * other's job. See docs/adr/0016-recording-documentation-gaps.md, which settles open question Q11.
 *
 * @example
 * ```ts
 * new GapReportPipeline('lugem-kb-dev', { config, githubConfig, ...wiring, oidcProviderArn });
 * ```
 */
export class GapReportPipeline extends pulumi.ComponentResource {
  public readonly roleArn: pulumi.Output<string>;
  public readonly environment: string;

  constructor(name: string, args: GapReportPipelineArgs, opts?: pulumi.ComponentResourceOptions) {
    super('lugem:github:GapReportPipeline', name, {}, opts);

    const role = this.createRole(name, args);
    this.createPolicy(name, args, role);

    new github.RepositoryEnvironment(
      `${name}-gap-report-environment`,
      {
        repository: args.repositoryName,
        environment: GAP_REPORT_ENVIRONMENT,
        canAdminsBypass: false,
        deploymentBranchPolicy: { protectedBranches: true, customBranchPolicies: false },
      },
      { parent: this },
    );

    this.publishVariables(name, args, role.arn);

    this.roleArn = role.arn;
    this.environment = GAP_REPORT_ENVIRONMENT;

    this.registerOutputs({ roleArn: this.roleArn, environment: this.environment });
  }

  /** Trusted for one repository and one environment, exactly as the publish role is. */
  private createRole(name: string, args: GapReportPipelineArgs): aws.iam.Role {
    const subject = `repo:${args.githubConfig.fullName}:environment:${GAP_REPORT_ENVIRONMENT}`;

    return new aws.iam.Role(
      `${name}-gap-report-role`,
      {
        description: 'GitHub Actions reads documentation gaps and files the rolling report',
        assumeRolePolicy: args.oidcProviderArn.apply((arn) =>
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

  /** Query on one table. No write, no delete — the report reads and reports, nothing else. */
  private createPolicy(name: string, args: GapReportPipelineArgs, role: aws.iam.Role): void {
    new aws.iam.RolePolicy(
      `${name}-gap-report-policy`,
      {
        role: role.id,
        policy: args.gapFeedbackTableArn.apply((tableArn) =>
          JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                Sid: 'ReadDocumentationGaps',
                Effect: 'Allow',
                Action: ['dynamodb:Query'],
                Resource: [tableArn],
              },
            ],
          }),
        ),
      },
      { parent: this },
    );
  }

  /** Repository variables, for the same reasons `PublishPipeline.publishVariables` documents. */
  private publishVariables(
    name: string,
    args: GapReportPipelineArgs,
    roleArn: pulumi.Output<string>,
  ): void {
    const variables: Record<string, pulumi.Input<string>> = {
      AWS_GAP_REPORT_ROLE_ARN: roleArn,
      GAP_FEEDBACK_TABLE: args.gapFeedbackTableName,
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
