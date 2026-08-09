import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

import { answerModelArns, type StackConfig } from '../config';
import { type Network } from '../network';
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
  readonly cmsAppId?: string | undefined;
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
        loadBalancers: [
          {
            targetGroupArn: args.targetGroupArn,
            containerName: CONTAINER_NAME,
            containerPort: config.containerPort,
          },
        ],
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

    return pulumi
      .all([
        args.imageUri,
        args.corpusBucketName,
        args.knowledgeBaseId,
        logGroupName,
        args.cmsSecretArn ?? pulumi.output(''),
      ])
      .apply(([imageUri, corpusBucket, knowledgeBaseId, logGroup, cmsSecretArn]) => {
        const environment: ContainerEnvironmentEntry[] = [
          { name: 'PORT', value: String(config.containerPort) },
          { name: 'AWS_REGION', value: config.region },
          { name: 'CORPUS_BUCKET', value: corpusBucket },
          { name: 'CORPUS_PREFIX', value: config.corpusPrefix },
          { name: 'KNOWLEDGE_BASE_ID', value: knowledgeBaseId },
          { name: 'SITE_ROOT', value: '/app/site' },
          { name: 'ANSWER_MODEL_ID', value: config.answerModelId },
          { name: 'ANSWER_MAX_TOKENS', value: String(config.answerMaxTokens) },
          { name: 'ASK_RATE_LIMIT_PER_MINUTE', value: String(config.askRateLimitPerMinute) },
          { name: 'RETRIEVAL_SCORE_THRESHOLD', value: String(config.retrievalScoreThreshold) },
        ];

        if (cmsSecretArn !== '') {
          environment.push({ name: 'CMS_APP_SECRET_ARN', value: cmsSecretArn });
        }
        if (args.cmsAppId !== undefined) {
          environment.push({ name: 'GITHUB_APP_ID', value: args.cmsAppId });
        }

        return JSON.stringify([
          {
            name: CONTAINER_NAME,
            image: imageUri,
            essential: true,
            portMappings: [{ containerPort: config.containerPort, protocol: 'tcp' }],
            environment,
            logConfiguration: {
              logDriver: 'awslogs',
              options: {
                'awslogs-group': logGroup,
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

  return pulumi
    .all([
      args.corpusBucketArn,
      args.knowledgeBaseArn,
      args.accountId,
      args.cmsSecretArn ?? pulumi.output(''),
    ])
    .apply(([bucketArn, knowledgeBaseArn, accountId, cmsSecretArn]) => {
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
      ];

      if (cmsSecretArn !== '') {
        statements.push({
          Sid: 'ReadOwnCmsSecret',
          Effect: 'Allow',
          Action: ['secretsmanager:GetSecretValue'],
          Resource: [cmsSecretArn],
        });
      }

      return JSON.stringify({ Version: '2012-10-17', Statement: statements });
    });
}
