import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

import { type StackConfig } from '../config';
import { type Network } from '../network';
import { reparentedChild } from './child-options';

const HTTP_PORT = 80;
const HTTPS_PORT = 443;
const HEALTH_CHECK_INTERVAL_SECONDS = 30;
const HEALTH_CHECK_TIMEOUT_SECONDS = 5;
const HEALTHY_THRESHOLD = 2;
const UNHEALTHY_THRESHOLD = 3;
const DEREGISTRATION_DELAY_SECONDS = 30;

/**
 * Raised from the AWS default of 60 seconds for the streamed answers on `/v1/ask`.
 *
 * The timer resets on every byte, so a streaming answer keeps the connection alive once it starts
 * — but the gap before the model's first token is dead air, and 60 seconds is not a comfortable
 * margin for a cold model under load. The route sends its citations frame before generation
 * begins, which is the primary mitigation; this is the second one.
 *
 * Note the interaction with `DEREGISTRATION_DELAY_SECONDS`: a deploy still cuts an answer that is
 * mid-stream after 30 seconds. That is accepted for a docs assistant — the reader retries.
 */
const IDLE_TIMEOUT_SECONDS = 120;

export interface GatewayIngressArgs {
  readonly config: StackConfig;
  readonly network: Network;
}

/**
 * The ALB, its security group, and the target group the service registers into.
 *
 * The health check hits `/healthz`, never `/readyz`: the target group decides whether a task
 * receives traffic, and a task whose S3 access is briefly failing should still be considered
 * alive. `/readyz` exists for the deployment gate, not for steady-state routing.
 *
 * @example
 * ```ts
 * const ingress = new GatewayIngress('lugem-kb-dev', { config, network });
 * ```
 */
export class GatewayIngress extends pulumi.ComponentResource {
  public readonly albSecurityGroupId: pulumi.Output<string>;
  public readonly targetGroupArn: pulumi.Output<string>;
  public readonly url: pulumi.Output<string>;

  constructor(name: string, args: GatewayIngressArgs, opts?: pulumi.ComponentResourceOptions) {
    super('lugem:net:GatewayIngress', name, {}, opts);

    const { config, network } = args;
    const listenerPort = config.certificateArn === undefined ? HTTP_PORT : HTTPS_PORT;

    const albSecurityGroup = new aws.ec2.SecurityGroup(
      `${name}-alb-sg`,
      {
        vpcId: network.vpcId,
        description: 'Ingress to the Lugem KB load balancer',
        ingress: [
          {
            protocol: 'tcp',
            fromPort: listenerPort,
            toPort: listenerPort,
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
      },
      reparentedChild(this),
    );

    const alb = new aws.lb.LoadBalancer(
      `${name}-alb`,
      {
        loadBalancerType: 'application',
        internal: config.albScheme === 'internal',
        securityGroups: [albSecurityGroup.id],
        subnets: [...network.publicSubnetIds],
        idleTimeout: IDLE_TIMEOUT_SECONDS,
      },
      reparentedChild(this),
    );

    const targetGroup = new aws.lb.TargetGroup(
      `${name}-tg`,
      {
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
      },
      reparentedChild(this),
    );

    this.createListeners(name, { config, alb, targetGroup });

    const scheme = config.certificateArn === undefined ? 'http' : 'https';

    this.albSecurityGroupId = albSecurityGroup.id;
    this.targetGroupArn = targetGroup.arn;
    this.url = pulumi.interpolate`${scheme}://${alb.dnsName}`;

    this.registerOutputs({
      albSecurityGroupId: this.albSecurityGroupId,
      targetGroupArn: this.targetGroupArn,
      url: this.url,
    });
  }

  /**
   * HTTPS when a certificate is configured, HTTP otherwise.
   *
   * Plain HTTP is the demo default because requiring a certificate would make the stack
   * undeployable without a domain. Any real deployment should set `certificateArn`.
   */
  private createListeners(name: string, args: ListenerArgs): void {
    const { config, alb, targetGroup } = args;
    const forward = [{ type: 'forward', targetGroupArn: targetGroup.arn }];

    if (config.certificateArn === undefined) {
      new aws.lb.Listener(
        `${name}-http`,
        {
          loadBalancerArn: alb.arn,
          port: HTTP_PORT,
          protocol: 'HTTP',
          defaultActions: forward,
        },
        reparentedChild(this),
      );
      return;
    }

    new aws.lb.Listener(
      `${name}-https`,
      {
        loadBalancerArn: alb.arn,
        port: HTTPS_PORT,
        protocol: 'HTTPS',
        sslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
        certificateArn: config.certificateArn,
        defaultActions: forward,
      },
      reparentedChild(this),
    );

    new aws.lb.Listener(
      `${name}-http-redirect`,
      {
        loadBalancerArn: alb.arn,
        port: HTTP_PORT,
        protocol: 'HTTP',
        defaultActions: [
          {
            type: 'redirect',
            redirect: { port: String(HTTPS_PORT), protocol: 'HTTPS', statusCode: 'HTTP_301' },
          },
        ],
      },
      reparentedChild(this),
    );
  }
}

interface ListenerArgs {
  readonly config: StackConfig;
  readonly alb: aws.lb.LoadBalancer;
  readonly targetGroup: aws.lb.TargetGroup;
}
