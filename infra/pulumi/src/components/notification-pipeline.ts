import * as aws from '@pulumi/aws';
import * as github from '@pulumi/github';
import * as pulumi from '@pulumi/pulumi';

import { type StackConfig } from '../config';
import { type GithubConfig } from '../github-config';

const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';
const STS_AUDIENCE = 'sts.amazonaws.com';

/** The GitHub deployment environment the notification workflow runs in, and the OIDC subject it claims. */
export const NOTIFY_ENVIRONMENT = 'notify';

export interface NotificationPipelineArgs {
  readonly config: StackConfig;
  readonly githubConfig: GithubConfig;
  readonly repositoryName: pulumi.Input<string>;
  /** The verified `From` address. Its presence is what makes this component exist at all. */
  readonly senderAddress: string;
  readonly recipientDomains: readonly string[];
  readonly cmsBranchPrefix: string;
  /** Taken from `PublishPipeline`, because an account holds at most one provider per URL. */
  readonly oidcProviderArn: pulumi.Output<string>;
}

/**
 * The credential path that lets a pull request event send one email (requirements.md R14).
 *
 * **A third role, for the same reason there is a second.** `PublishPipeline` is scoped to "exactly
 * the calls `sync-corpus.ts` makes" and `GapReportPipeline` to one `dynamodb:Query`. Sending mail
 * belongs to neither: a role that can publish the corpus should not also be able to send mail from
 * a corporate-verified address, and the role that can read reader questions least of all.
 *
 * The policy grants `ses:SendEmail` with a condition pinning the `From` address, so the credential
 * cannot be repurposed to send as anyone else in the account — the same shape of confinement the
 * gateway's path and branch policies apply to writes.
 *
 * Creating the identity here rather than assuming one means `pulumi up` requests verification and
 * the operator completes it; an unverified identity fails the first send loudly instead of
 * silently delivering nothing.
 *
 * @example
 * ```ts
 * new NotificationPipeline('lugem-kb-dev', { config, githubConfig, senderAddress, ...wiring });
 * ```
 */
export class NotificationPipeline extends pulumi.ComponentResource {
  public readonly roleArn: pulumi.Output<string>;
  public readonly senderIdentityArn: pulumi.Output<string>;
  public readonly environment: string;

  constructor(
    name: string,
    args: NotificationPipelineArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super('lugem:github:NotificationPipeline', name, {}, opts);

    const identity = new aws.sesv2.EmailIdentity(
      `${name}-notify-sender`,
      { emailIdentity: args.senderAddress },
      { parent: this },
    );

    const role = this.createRole(name, args);
    this.createPolicy(name, args.senderAddress, { role, identityArn: identity.arn });

    new github.RepositoryEnvironment(
      `${name}-notify-environment`,
      {
        repository: args.repositoryName,
        environment: NOTIFY_ENVIRONMENT,
        canAdminsBypass: false,
        deploymentBranchPolicy: { protectedBranches: true, customBranchPolicies: false },
      },
      { parent: this },
    );

    this.publishVariables(name, args, role.arn);

    this.roleArn = role.arn;
    this.senderIdentityArn = identity.arn;
    this.environment = NOTIFY_ENVIRONMENT;

    this.registerOutputs({
      roleArn: this.roleArn,
      senderIdentityArn: this.senderIdentityArn,
      environment: this.environment,
    });
  }

  /** Trusted for one repository and one environment, exactly as the other two pipelines are. */
  private createRole(name: string, args: NotificationPipelineArgs): aws.iam.Role {
    const subject = `repo:${args.githubConfig.fullName}:environment:${NOTIFY_ENVIRONMENT}`;

    return new aws.iam.Role(
      `${name}-notify-role`,
      {
        description: 'GitHub Actions sends documentation review notifications',
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

  /**
   * Send, from one identity, as one address.
   *
   * The `ses:FromAddress` condition is the part worth reading. Without it the role could send as
   * any verified identity in the account — which for most accounts includes addresses that have
   * nothing to do with documentation.
   */
  private createPolicy(
    name: string,
    senderAddress: string,
    target: { readonly role: aws.iam.Role; readonly identityArn: pulumi.Output<string> },
  ): void {
    new aws.iam.RolePolicy(
      `${name}-notify-policy`,
      {
        role: target.role.id,
        policy: target.identityArn.apply((arn) =>
          JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                Sid: 'SendAsTheDocumentationSenderOnly',
                Effect: 'Allow',
                Action: ['ses:SendEmail'],
                Resource: [arn],
                Condition: { StringEquals: { 'ses:FromAddress': senderAddress } },
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
    args: NotificationPipelineArgs,
    roleArn: pulumi.Output<string>,
  ): void {
    const variables: Record<string, pulumi.Input<string>> = {
      AWS_NOTIFY_ROLE_ARN: roleArn,
      NOTIFY_SENDER: args.senderAddress,
      NOTIFY_RECIPIENT_DOMAINS: args.recipientDomains.join(','),
      CMS_BRANCH_PREFIX: args.cmsBranchPrefix,
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
