import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

import { type StackConfig } from './config';
import { type Network } from './network';

const HTTP_PORT = 80;
const HTTPS_PORT = 443;
const HEALTH_CHECK_INTERVAL_SECONDS = 30;
const HEALTH_CHECK_TIMEOUT_SECONDS = 5;
const HEALTHY_THRESHOLD = 2;
const UNHEALTHY_THRESHOLD = 3;
const DEREGISTRATION_DELAY_SECONDS = 30;

export interface LoadBalancerArgs {
  readonly config: StackConfig;
  readonly network: Network;
}

export interface LoadBalancer {
  readonly albSecurityGroup: aws.ec2.SecurityGroup;
  readonly targetGroup: aws.lb.TargetGroup;
  readonly dnsName: pulumi.Output<string>;
  readonly url: pulumi.Output<string>;
}

/**
 * The ALB, its security group, and the target group the service registers into.
 *
 * The health check hits `/healthz`, never `/readyz`: the target group decides whether a task
 * receives traffic, and a task whose S3 access is briefly failing should still be considered
 * alive. `/readyz` exists for the deployment gate, not for steady-state routing.
 *
 * @param name - Resource name prefix.
 * @param args - Stack config and the resolved existing-VPC network.
 * @returns The security group, target group and public address.
 */
export function createLoadBalancer(name: string, args: LoadBalancerArgs): LoadBalancer {
  const { config, network } = args;

  const albSecurityGroup = new aws.ec2.SecurityGroup(`${name}-alb-sg`, {
    vpcId: network.vpcId,
    description: 'Ingress to the Lugem KB load balancer',
    ingress: [
      {
        protocol: 'tcp',
        fromPort: config.certificateArn === undefined ? HTTP_PORT : HTTPS_PORT,
        toPort: config.certificateArn === undefined ? HTTP_PORT : HTTPS_PORT,
        cidrBlocks: ['0.0.0.0/0'],
        description: 'Client traffic',
      },
    ],
    egress: [
      {
        protocol: '-1',
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ['0.0.0.0/0'],
        description: 'To the service tasks',
      },
    ],
  });

  const alb = new aws.lb.LoadBalancer(`${name}-alb`, {
    loadBalancerType: 'application',
    internal: config.albScheme === 'internal',
    securityGroups: [albSecurityGroup.id],
    subnets: [...network.publicSubnetIds],
  });

  const targetGroup = new aws.lb.TargetGroup(`${name}-tg`, {
    port: config.containerPort,
    protocol: 'HTTP',
    targetType: 'ip',
    vpcId: network.vpcId,
    deregistrationDelay: DEREGISTRATION_DELAY_SECONDS,
    healthCheck: {
      path: '/healthz',
      protocol: 'HTTP',
      matcher: '200',
      interval: HEALTH_CHECK_INTERVAL_SECONDS,
      timeout: HEALTH_CHECK_TIMEOUT_SECONDS,
      healthyThreshold: HEALTHY_THRESHOLD,
      unhealthyThreshold: UNHEALTHY_THRESHOLD,
    },
  });

  createListener(name, { config, alb, targetGroup });

  const scheme = config.certificateArn === undefined ? 'http' : 'https';
  return {
    albSecurityGroup,
    targetGroup,
    dnsName: alb.dnsName,
    url: pulumi.interpolate`${scheme}://${alb.dnsName}`,
  };
}

interface ListenerArgs {
  readonly config: StackConfig;
  readonly alb: aws.lb.LoadBalancer;
  readonly targetGroup: aws.lb.TargetGroup;
}

/**
 * HTTPS when a certificate is configured, HTTP otherwise.
 *
 * Plain HTTP is the demo default because requiring a certificate would make the stack
 * undeployable without a domain. Any real deployment should set `certificateArn`.
 */
function createListener(name: string, args: ListenerArgs): void {
  const { config, alb, targetGroup } = args;
  const forward = [{ type: 'forward', targetGroupArn: targetGroup.arn }];

  if (config.certificateArn === undefined) {
    new aws.lb.Listener(`${name}-http`, {
      loadBalancerArn: alb.arn,
      port: HTTP_PORT,
      protocol: 'HTTP',
      defaultActions: forward,
    });
    return;
  }

  new aws.lb.Listener(`${name}-https`, {
    loadBalancerArn: alb.arn,
    port: HTTPS_PORT,
    protocol: 'HTTPS',
    sslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
    certificateArn: config.certificateArn,
    defaultActions: forward,
  });

  new aws.lb.Listener(`${name}-http-redirect`, {
    loadBalancerArn: alb.arn,
    port: HTTP_PORT,
    protocol: 'HTTP',
    defaultActions: [
      {
        type: 'redirect',
        redirect: { port: String(HTTPS_PORT), protocol: 'HTTPS', statusCode: 'HTTP_301' },
      },
    ],
  });
}
