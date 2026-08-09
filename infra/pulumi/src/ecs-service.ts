import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

import { type StackConfig } from './config';
import { type TaskRoles } from './iam';
import { type LoadBalancer } from './load-balancer';
import { type Network } from './network';

const CONTAINER_NAME = 'gateway';
const HEALTH_CHECK_GRACE_PERIOD_SECONDS = 60;

export interface ServiceArgs {
  readonly config: StackConfig;
  readonly network: Network;
  readonly loadBalancer: LoadBalancer;
  readonly roles: TaskRoles;
  readonly imageUri: pulumi.Output<string>;
  readonly corpusBucketName: pulumi.Output<string>;
  readonly knowledgeBaseId: pulumi.Output<string>;
}

export interface Service {
  readonly serviceName: pulumi.Output<string>;
  readonly clusterName: pulumi.Output<string>;
  readonly logGroupName: pulumi.Output<string>;
}

/**
 * The Fargate service running the gateway.
 *
 * Tasks sit in private subnets with no public IP: the ALB is the only ingress path, and the
 * security group below is what enforces it — the task group accepts traffic from the ALB's
 * security group alone, not from a CIDR that happens to contain it.
 *
 * @param name - Resource name prefix.
 * @param args - Everything the task needs to run and be reached.
 * @returns Service, cluster and log group names.
 */
export function createService(name: string, args: ServiceArgs): Service {
  const { config, network, loadBalancer } = args;

  const cluster = new aws.ecs.Cluster(`${name}-cluster`, {
    settings: [{ name: 'containerInsights', value: 'enabled' }],
  });

  const logGroup = new aws.cloudwatch.LogGroup(`${name}-logs`, {
    retentionInDays: config.logRetentionDays,
  });

  const serviceSecurityGroup = new aws.ec2.SecurityGroup(`${name}-service-sg`, {
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
  });

  new aws.vpc.SecurityGroupIngressRule(`${name}-service-ingress`, {
    securityGroupId: serviceSecurityGroup.id,
    referencedSecurityGroupId: loadBalancer.albSecurityGroup.id,
    ipProtocol: 'tcp',
    fromPort: config.containerPort,
    toPort: config.containerPort,
    description: 'Only the load balancer may reach the container port',
  });

  const taskDefinition = createTaskDefinition(name, { args, logGroup });

  const service = new aws.ecs.Service(`${name}-service`, {
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
        targetGroupArn: loadBalancer.targetGroup.arn,
        containerName: CONTAINER_NAME,
        containerPort: config.containerPort,
      },
    ],
    healthCheckGracePeriodSeconds: HEALTH_CHECK_GRACE_PERIOD_SECONDS,
    deploymentCircuitBreaker: { enable: true, rollback: true },
    waitForSteadyState: true,
  });

  return { serviceName: service.name, clusterName: cluster.name, logGroupName: logGroup.name };
}

interface TaskDefinitionArgs {
  readonly args: ServiceArgs;
  readonly logGroup: aws.cloudwatch.LogGroup;
}

function createTaskDefinition(
  name: string,
  { args, logGroup }: TaskDefinitionArgs,
): aws.ecs.TaskDefinition {
  const { config, roles } = args;

  const containerDefinitions = pulumi
    .all([args.imageUri, args.corpusBucketName, args.knowledgeBaseId, logGroup.name, config.region])
    .apply(([imageUri, corpusBucket, knowledgeBaseId, logGroupName, region]) =>
      JSON.stringify([
        {
          name: CONTAINER_NAME,
          image: imageUri,
          essential: true,
          portMappings: [{ containerPort: config.containerPort, protocol: 'tcp' }],
          environment: [
            { name: 'PORT', value: String(config.containerPort) },
            { name: 'AWS_REGION', value: region },
            { name: 'CORPUS_BUCKET', value: corpusBucket },
            { name: 'CORPUS_PREFIX', value: config.corpusPrefix },
            { name: 'KNOWLEDGE_BASE_ID', value: knowledgeBaseId },
            { name: 'SITE_ROOT', value: '/app/site' },
          ],
          logConfiguration: {
            logDriver: 'awslogs',
            options: {
              'awslogs-group': logGroupName,
              'awslogs-region': region,
              'awslogs-stream-prefix': CONTAINER_NAME,
            },
          },
        },
      ]),
    );

  return new aws.ecs.TaskDefinition(`${name}-task`, {
    family: `${name}-gateway`,
    networkMode: 'awsvpc',
    requiresCompatibilities: ['FARGATE'],
    cpu: String(config.cpu),
    memory: String(config.memory),
    executionRoleArn: roles.executionRole.arn,
    taskRoleArn: roles.taskRole.arn,
    runtimePlatform: { cpuArchitecture: 'X86_64', operatingSystemFamily: 'LINUX' },
    containerDefinitions,
  });
}
