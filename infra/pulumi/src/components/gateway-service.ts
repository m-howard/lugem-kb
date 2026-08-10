import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

import { answerModelArns, type StackConfig } from '../config';
import { type CmsAppConfig, type CmsGatewayConfig } from '../github-config';
import { type Network } from '../network';
import { allStrings } from '../resolve-strings';
import { reparentedChild } from './child-options';

const CONTAINER_NAME = 'gateway';
const HEALTH_CHECK_GRACE_PERIOD_SECONDS = 60;

const ECS_TASKS_ASSUME_ROLE_POLICY = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { Service: 'ecs-tasks.amazonaws.com' },
      Action: 'sts:AssumeRole',
    },
  ],
});

export interface GatewayServiceArgs {
  readonly config: StackConfig;
  readonly network: Network;
  readonly albSecurityGroupId: pulumi.Output<string>;
  readonly targetGroupArn: pulumi.Output<string>;
  /**
   * Editorial target group, present when the CMS is configured.
   *
   * Registering with both is what makes requirements.md R10 true: this one probes `/readyz`, so a
   * task that cannot mint an installation token is removed from it while staying in the public
   * group and continuing to serve readers. It also gates the deploy — ECS waits for health in
   * every attached group, so a rollout with a bad credential never stabilises.
   */
  readonly cmsTargetGroupArn?: pulumi.Output<string> | undefined;
  readonly imageUri: pulumi.Output<string>;
  readonly corpusBucketName: pulumi.Output<string>;
  readonly corpusBucketArn: pulumi.Output<string>;
  readonly knowledgeBaseId: pulumi.Output<string>;
  readonly knowledgeBaseArn: pulumi.Output<string>;
  /**
   * The deploying account, for the answer model's inference-profile ARN.
   *
   * Resolved in `index.ts` against the explicit provider rather than looked up here: a bare
   * `getCallerIdentityOutput()` inside this file would run against the ambient default provider,
   * which is the same trap `network.ts` documents for its own lookups.
   */
  readonly accountId: pulumi.Output<string>;
  /** ARN of the Secrets Manager secret holding the CMS GitHub App private key — requirements.md R2. */
  readonly cmsSecretArn?: pulumi.Output<string> | undefined;
  /** The GitHub App and what it may touch. Absent means the editorial routes are never mounted. */
  readonly cms?: GatewayCmsArgs | undefined;
  readonly gapFeedbackTableName: pulumi.Output<string>;
  readonly gapFeedbackTableArn: pulumi.Output<string>;
  /**
   * The pull request preview bucket and where it is served from (requirements.md R12).
   *
   * Absent means `/previews` is never mounted and the CMS workflow card offers no link — the state
   * of every deployment that does not manage a GitHub repository. See ADR 0018.
   */
  readonly previews?: GatewayPreviewArgs | undefined;
}

/** Both halves, or neither: `resolvePreviewConfig` refuses a bucket with no base URL. */
export interface GatewayPreviewArgs {
  readonly bucketName: pulumi.Output<string>;
  readonly bucketArn: pulumi.Output<string>;
  readonly baseUrl: pulumi.Output<string>;
}

/** Everything `apps/gateway/src/config.ts` needs to switch its CMS block on — requirements.md R10. */
export interface GatewayCmsArgs {
  readonly app: CmsAppConfig;
  readonly gateway: CmsGatewayConfig;
  readonly repository: pulumi.Output<string>;
  readonly defaultBranch: string;
  /** ARN of this stack's load balancer, which `alb` mode checks every token's signer against. */
  readonly loadBalancerArn?: pulumi.Output<string> | undefined;
}

/**
 * The Fargate service running the gateway, and the two roles it runs as.
 *
 * Tasks sit in private subnets with no public IP: the ALB is the only ingress path, and the
 * security group below is what enforces it — the task group accepts traffic from the ALB's
 * security group alone, not from a CIDR that happens to contain it.
 *
 * The execution role and the task role stay separate on purpose. The execution role is what ECS
 * itself uses to pull the image and write logs; the task role is what the application code gets.
 * Merging them — a common shortcut — would hand the running container the ability to pull and push
 * images, which has nothing to do with serving documents.
 *
 * @example
 * ```ts
 * const service = new GatewayService('lugem-kb-dev', { config, network, ...wiring });
 * ```
 */
export class GatewayService extends pulumi.ComponentResource {
  public readonly serviceName: pulumi.Output<string>;
  public readonly clusterName: pulumi.Output<string>;
  public readonly logGroupName: pulumi.Output<string>;

  constructor(name: string, args: GatewayServiceArgs, opts?: pulumi.ComponentResourceOptions) {
    super('lugem:ecs:GatewayService', name, {}, opts);

    const { config, network } = args;

    const cluster = new aws.ecs.Cluster(
      `${name}-cluster`,
      { settings: [{ name: 'containerInsights', value: 'enabled' }] },
      reparentedChild(this),
    );

    const logGroup = new aws.cloudwatch.LogGroup(
      `${name}-logs`,
      { retentionInDays: config.logRetentionDays },
      reparentedChild(this),
    );

    const serviceSecurityGroup = new aws.ec2.SecurityGroup(
      `${name}-service-sg`,
      {
        vpcId: network.vpcId,
        description: 'Lugem KB gateway tasks',
        egress: [
          {
            protocol: '-1',
            fromPort: 0,
            toPort: 0,
            cidrBlocks: ['0.0.0.0/0'],
            description: 'To S3, Bedrock and ECR',
          },
        ],
      },
      reparentedChild(this),
    );

    new aws.vpc.SecurityGroupIngressRule(
      `${name}-service-ingress`,
      {
        securityGroupId: serviceSecurityGroup.id,
        referencedSecurityGroupId: args.albSecurityGroupId,
        ipProtocol: 'tcp',
        fromPort: config.containerPort,
        toPort: config.containerPort,
        description: 'Only the load balancer may reach the container port',
      },
      reparentedChild(this),
    );

    const taskDefinition = this.createTaskDefinition(name, args, logGroup);

    const service = new aws.ecs.Service(
      `${name}-service`,
      {
        cluster: cluster.arn,
        taskDefinition: taskDefinition.arn,
        desiredCount: config.desiredCount,
        launchType: 'FARGATE',
        networkConfiguration: {
          subnets: [...network.privateSubnetIds],
          securityGroups: [serviceSecurityGroup.id],
          assignPublicIp: false,
        },
        loadBalancers: loadBalancerRegistrations(args),
        healthCheckGracePeriodSeconds: HEALTH_CHECK_GRACE_PERIOD_SECONDS,
        deploymentCircuitBreaker: { enable: true, rollback: true },
        waitForSteadyState: true,
      },
      reparentedChild(this),
    );

    this.serviceName = service.name;
    this.clusterName = cluster.name;
    this.logGroupName = logGroup.name;

    this.registerOutputs({
      serviceName: this.serviceName,
      clusterName: this.clusterName,
      logGroupName: this.logGroupName,
    });
  }

  private createTaskDefinition(
    name: string,
    args: GatewayServiceArgs,
    logGroup: aws.cloudwatch.LogGroup,
  ): aws.ecs.TaskDefinition {
    const { config } = args;
    const roles = this.createTaskRoles(name, args);

    return new aws.ecs.TaskDefinition(
      `${name}-task`,
      {
        family: `${name}-gateway`,
        networkMode: 'awsvpc',
        requiresCompatibilities: ['FARGATE'],
        cpu: String(config.cpu),
        memory: String(config.memory),
        executionRoleArn: roles.executionRole.arn,
        taskRoleArn: roles.taskRole.arn,
        runtimePlatform: { cpuArchitecture: 'X86_64', operatingSystemFamily: 'LINUX' },
        containerDefinitions: this.containerDefinitions(args, logGroup.name),
      },
      reparentedChild(this),
    );
  }

  private createTaskRoles(name: string, args: GatewayServiceArgs): TaskRoles {
    const executionRole = new aws.iam.Role(
      `${name}-execution-role`,
      { assumeRolePolicy: ECS_TASKS_ASSUME_ROLE_POLICY },
      reparentedChild(this),
    );

    new aws.iam.RolePolicyAttachment(
      `${name}-execution-role-managed`,
      {
        role: executionRole.name,
        policyArn: aws.iam.ManagedPolicy.AmazonECSTaskExecutionRolePolicy,
      },
      reparentedChild(this),
    );

    const taskRole = new aws.iam.Role(
      `${name}-task-role`,
      { assumeRolePolicy: ECS_TASKS_ASSUME_ROLE_POLICY },
      reparentedChild(this),
    );

    new aws.iam.RolePolicy(
      `${name}-task-policy`,
      { role: taskRole.id, policy: taskPolicyDocument(args) },
      reparentedChild(this),
    );

    return { executionRole, taskRole };
  }

  /**
   * The container contract with `apps/gateway`. Every name here is read by
   * `apps/gateway/src/config.ts`, which fails closed on a missing one (ADR 0009).
   */
  private containerDefinitions(
    args: GatewayServiceArgs,
    logGroupName: pulumi.Output<string>,
  ): pulumi.Output<string> {
    const { config } = args;

    // Resolved by name rather than by position — see `allStrings` for what that replaced.
    return allStrings({
      imageUri: args.imageUri,
      corpusBucket: args.corpusBucketName,
      knowledgeBaseId: args.knowledgeBaseId,
      logGroup: logGroupName,
      cmsSecretArn: args.cmsSecretArn ?? pulumi.output(''),
      repository: args.cms?.repository ?? pulumi.output(''),
      albArn: args.cms?.loadBalancerArn ?? pulumi.output(''),
      gapFeedbackTable: args.gapFeedbackTableName,
      previewBucket: args.previews?.bucketName ?? pulumi.output(''),
      previewBaseUrl: args.previews?.baseUrl ?? pulumi.output(''),
    }).apply((resolved) => {
      const environment: ContainerEnvironmentEntry[] = [
        { name: 'PORT', value: String(config.containerPort) },
        { name: 'AWS_REGION', value: config.region },
        { name: 'CORPUS_BUCKET', value: resolved.corpusBucket },
        { name: 'CORPUS_PREFIX', value: config.corpusPrefix },
        { name: 'KNOWLEDGE_BASE_ID', value: resolved.knowledgeBaseId },
        { name: 'SITE_ROOT', value: '/app/site' },
        { name: 'ANSWER_MODEL_ID', value: config.answerModelId },
        { name: 'ANSWER_MAX_TOKENS', value: String(config.answerMaxTokens) },
        { name: 'ASK_RATE_LIMIT_PER_MINUTE', value: String(config.askRateLimitPerMinute) },
        { name: 'RETRIEVAL_SCORE_THRESHOLD', value: String(config.retrievalScoreThreshold) },
        { name: 'GAP_FEEDBACK_TABLE', value: resolved.gapFeedbackTable },
        { name: 'GAP_FEEDBACK_RETENTION_DAYS', value: String(config.gapFeedbackRetentionDays) },
        { name: 'READER_AUTH_REQUIRED', value: String(config.readerAuthRequired) },
        ...cmsEnvironment(args.cms, resolved),
        ...previewEnvironment(resolved),
      ];

      return JSON.stringify([
        {
          name: CONTAINER_NAME,
          image: resolved.imageUri,
          essential: true,
          portMappings: [{ containerPort: config.containerPort, protocol: 'tcp' }],
          environment,
          logConfiguration: {
            logDriver: 'awslogs',
            options: {
              'awslogs-group': resolved.logGroup,
              'awslogs-region': config.region,
              'awslogs-stream-prefix': CONTAINER_NAME,
            },
          },
        },
      ]);
    });
  }
}

interface TaskRoles {
  readonly executionRole: aws.iam.Role;
  readonly taskRole: aws.iam.Role;
}

interface ContainerEnvironmentEntry {
  readonly name: string;
  readonly value: string;
}

interface PolicyStatement {
  readonly Sid: string;
  readonly Effect: 'Allow';
  readonly Action: readonly string[];
  readonly Resource: readonly string[];
  readonly Condition?: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
}

/**
 * Everything the running container is allowed to do, in one place.
 *
 * This is the infra half of requirements.md R2 and R5: one bucket, one prefix, one knowledge base
 * ARN, and — when the CMS app is configured — exactly one secret. No wildcards. Keeping every
 * grant in a single document is what makes "the task role holds no permissions beyond reading its
 * own secret" checkable by reading one function.
 */
function taskPolicyDocument(args: GatewayServiceArgs): pulumi.Output<string> {
  const { config } = args;

  // By name, for the reason `containerDefinitions` gives.
  return allStrings({
    bucketArn: args.corpusBucketArn,
    knowledgeBaseArn: args.knowledgeBaseArn,
    accountId: args.accountId,
    cmsSecretArn: args.cmsSecretArn ?? pulumi.output(''),
    gapFeedbackTableArn: args.gapFeedbackTableArn,
    previewBucketArn: args.previews?.bucketArn ?? pulumi.output(''),
  }).apply(
    ({
      bucketArn,
      knowledgeBaseArn,
      accountId,
      cmsSecretArn,
      gapFeedbackTableArn,
      previewBucketArn,
    }) => {
      const statements: PolicyStatement[] = [
        {
          Sid: 'ListCorpusPrefixOnly',
          Effect: 'Allow',
          Action: ['s3:ListBucket'],
          Resource: [bucketArn],
          Condition: { StringLike: { 's3:prefix': [`${config.corpusPrefix}*`] } },
        },
        {
          Sid: 'ReadCorpusPrefixOnly',
          Effect: 'Allow',
          Action: ['s3:GetObject'],
          Resource: [`${bucketArn}/${config.corpusPrefix}*`],
        },
        {
          Sid: 'RetrieveFromOneKnowledgeBase',
          Effect: 'Allow',
          Action: ['bedrock:Retrieve'],
          Resource: [knowledgeBaseArn],
        },
        // Generation, granted separately from retrieval and scoped to the single configured
        // model. Retrieval decides whether this is used at all: a question the corpus does not
        // cover never reaches the model. See
        // docs/adr/0012-grounded-generation-behind-retrieval.md.
        {
          Sid: 'GenerateAnswersWithOneModel',
          Effect: 'Allow',
          Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
          Resource: answerModelArns(config, accountId),
        },
        // Write, and nothing else. The service that collects reader questions cannot read a single
        // one back — no Query, no Scan, no GetItem. Only the scheduled gap report holds that, under
        // a separate role. It is the strongest sentence in the answer to open question Q11, and it
        // is true because of this statement. See docs/adr/0016-recording-documentation-gaps.md.
        {
          Sid: 'RecordDocumentationGapsWriteOnly',
          Effect: 'Allow',
          Action: ['dynamodb:PutItem'],
          Resource: [gapFeedbackTableArn],
        },
      ];

      if (cmsSecretArn !== '') {
        statements.push({
          Sid: 'ReadOwnCmsSecret',
          Effect: 'Allow',
          Action: ['secretsmanager:GetSecretValue'],
          Resource: [cmsSecretArn],
        });
      }

      // Read, on the preview bucket only, under `pr-*` only.
      //
      // `s3:ListBucket` comes with it, and unconditionally — unlike the corpus grant above, which
      // narrows the same action with an `s3:prefix` condition. That difference is deliberate and
      // it is not about listing: a `GetObject` on a key that is not there answers `AccessDenied`
      // rather than `NoSuchKey` when the caller cannot list the bucket, and `s3:prefix` is not in
      // a `GetObject` request's context, so a conditioned grant would not change that answer.
      // Without this the gateway cannot tell "the build has not finished" from "this deployment's
      // permissions are wrong", and `previews/preview-client.ts` would have to call both a 404.
      // The bucket holds nothing but preview builds this role may already read.
      if (previewBucketArn !== '') {
        statements.push(
          {
            Sid: 'ReadPreviewsOnly',
            Effect: 'Allow',
            Action: ['s3:GetObject'],
            Resource: [`${previewBucketArn}/pr-*`],
          },
          {
            Sid: 'DistinguishAMissingPreviewFromARefusal',
            Effect: 'Allow',
            Action: ['s3:ListBucket'],
            Resource: [previewBucketArn],
          },
        );
      }

      return JSON.stringify({ Version: '2012-10-17', Statement: statements });
    },
  );
}

/**
 * The preview half of the container contract (requirements.md R12).
 *
 * Emits the whole block or none of it, for the reason `cmsEnvironment` documents: `PREVIEW_BUCKET`
 * is a master switch in `apps/gateway/src/config.ts` and `PREVIEW_BASE_URL` becomes required with
 * it, so half a block is a start-up failure rather than a degraded service.
 */
function previewEnvironment(resolved: {
  readonly previewBucket: string;
  readonly previewBaseUrl: string;
}): ContainerEnvironmentEntry[] {
  if (resolved.previewBucket === '' || resolved.previewBaseUrl === '') {
    return [];
  }

  return [
    { name: 'PREVIEW_BUCKET', value: resolved.previewBucket },
    { name: 'PREVIEW_BASE_URL', value: resolved.previewBaseUrl },
  ];
}

/**
 * The CMS half of the container contract.
 *
 * Every name is read by `resolveCmsConfig` in `apps/gateway/src/config.ts`, which treats
 * `CMS_REPOSITORY` as a master switch and then requires the rest — so this function emits the
 * whole block or none of it. Emitting half would produce a task that boots, passes `/healthz` and
 * refuses the first author, which is the failure ADR 0009 exists to move to start-up.
 */
function cmsEnvironment(
  cms: GatewayCmsArgs | undefined,
  resolved: { readonly cmsSecretArn: string; readonly repository: string; readonly albArn: string },
): ContainerEnvironmentEntry[] {
  if (cms === undefined || resolved.repository === '' || resolved.cmsSecretArn === '') {
    return [];
  }

  const { gateway } = cms;
  const entries: ContainerEnvironmentEntry[] = [
    { name: 'CMS_REPOSITORY', value: resolved.repository },
    { name: 'CMS_DEFAULT_BRANCH', value: cms.defaultBranch },
    { name: 'CMS_BRANCH_PREFIX', value: gateway.branchPrefix },
    { name: 'CMS_PATH_PREFIXES', value: gateway.pathPrefixes.join(',') },
    { name: 'CMS_APP_SECRET_ARN', value: resolved.cmsSecretArn },
    { name: 'GITHUB_APP_ID', value: cms.app.appId },
    { name: 'GITHUB_APP_INSTALLATION_ID', value: cms.app.installationId },
    { name: 'AUTH_MODE', value: gateway.authMode },
    { name: 'POLICY_ALLOW_MERGE_FROM_CMS', value: String(gateway.allowMerge) },
  ];

  if (gateway.authMode === 'alb') {
    entries.push({ name: 'AUTH_ALB_ARN', value: resolved.albArn });
  } else {
    entries.push(
      { name: 'AUTH_ISSUER_URL', value: gateway.issuerUrl ?? '' },
      { name: 'AUTH_AUDIENCE', value: gateway.audience ?? '' },
      { name: 'AUTH_CLIENT_ID', value: gateway.clientId ?? '' },
    );
  }

  if (gateway.emailClaim !== undefined) {
    entries.push({ name: 'AUTH_EMAIL_CLAIM', value: gateway.emailClaim });
  }
  if (gateway.nameClaim !== undefined) {
    entries.push({ name: 'AUTH_NAME_CLAIM', value: gateway.nameClaim });
  }

  return entries;
}

/**
 * Which target groups this service registers with.
 *
 * Two when the CMS is configured: the public group probing `/healthz`, and the editorial group
 * probing `/readyz`. ECS keeps a task in each group independently, so an unusable GitHub App
 * credential removes it from the editorial group alone — readers are unaffected — and a deploy
 * carrying one never reaches a stable state, which is what makes requirements.md R10 enforced
 * rather than merely documented.
 */
function loadBalancerRegistrations(args: GatewayServiceArgs) {
  const registration = {
    containerName: CONTAINER_NAME,
    containerPort: args.config.containerPort,
  };

  return [
    { ...registration, targetGroupArn: args.targetGroupArn },
    ...(args.cmsTargetGroupArn === undefined
      ? []
      : [{ ...registration, targetGroupArn: args.cmsTargetGroupArn }]),
  ];
}
