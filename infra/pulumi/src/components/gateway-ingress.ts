import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

import { type StackConfig } from '../config';
import { type CmsOidcListenerConfig } from '../github-config';
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

/**
 * Rule priorities. ALB evaluates ascending, so the sign-in rule must precede the deny rule that
 * would otherwise swallow its path.
 */
const CMS_SIGN_IN_RULE_PRIORITY = 5;
const CMS_AUTH_RULE_PRIORITY = 10;

/** Only the editorial surface is authenticated at the edge — never the site or `/v1/ask`. */
const CMS_PATH_PATTERN = '/v1/cms/*';

/**
 * Where a browser goes to obtain an ALB session, and the one route that redirects to the IdP.
 *
 * `/v1/cms/identity` already exists and already answers "who does the gateway think you are",
 * which is exactly what you want to see after signing in. Reusing it means ALB mode needs no route
 * that exists solely to be a login page.
 */
const CMS_SIGN_IN_PATH = '/v1/cms/identity';

export interface GatewayIngressArgs {
  readonly config: StackConfig;
  readonly network: Network;
  /** Present only in `cmsAuthMode: alb`, where the load balancer runs the OIDC exchange. */
  readonly cmsAuth?: CmsAlbAuthArgs | undefined;
}

export interface CmsAlbAuthArgs {
  readonly oidc: CmsOidcListenerConfig;
  /** Held as an Output so it stays encrypted in state — read with `config.requireSecret`. */
  readonly clientSecret: pulumi.Output<string>;
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
  /** What `AUTH_MODE=alb` checks every token's `signer` header against — requirements.md R1. */
  public readonly loadBalancerArn: pulumi.Output<string>;

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

    const httpsListener = this.createListeners(name, { config, alb, targetGroup });

    if (args.cmsAuth !== undefined && httpsListener !== undefined) {
      this.createCmsAuthRule(name, { auth: args.cmsAuth, listener: httpsListener, targetGroup });
    }

    const scheme = config.certificateArn === undefined ? 'http' : 'https';

    this.albSecurityGroupId = albSecurityGroup.id;
    this.targetGroupArn = targetGroup.arn;
    this.loadBalancerArn = alb.arn;
    this.url = pulumi.interpolate`${scheme}://${alb.dnsName}`;

    this.registerOutputs({
      albSecurityGroupId: this.albSecurityGroupId,
      targetGroupArn: this.targetGroupArn,
      loadBalancerArn: this.loadBalancerArn,
      url: this.url,
    });
  }

  /**
   * HTTPS when a certificate is configured, HTTP otherwise.
   *
   * Plain HTTP is the demo default because requiring a certificate would make the stack
   * undeployable without a domain. Any real deployment should set `certificateArn`.
   */
  private createListeners(name: string, args: ListenerArgs): aws.lb.Listener | undefined {
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
      return undefined;
    }

    const https = new aws.lb.Listener(
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

    return https;
  }

  /**
   * Authenticates the editorial surface at the edge, and nothing else.
   *
   * This is a listener *rule* rather than the listener's default action, and the distinction is
   * the whole design. Authenticating the default action would put an identity provider redirect in
   * front of the public documentation site and `/v1/ask`, which every reader uses and R22 has not
   * asked to protect yet. Health checks are unaffected either way — the target group reaches the
   * task directly, not through the listener.
   *
   * The gateway still verifies the resulting JWT itself. The rule decides who may reach `/v1/cms`;
   * `alb-verifier.ts` decides who the request is *from*, and refuses a token signed by any load
   * balancer but this one.
   */
  private createCmsAuthRule(name: string, args: CmsAuthRuleArgs): void {
    const { auth, listener, targetGroup } = args;

    new aws.lb.ListenerRule(
      `${name}-cms-auth`,
      {
        listenerArn: listener.arn,
        priority: CMS_AUTH_RULE_PRIORITY,
        conditions: [{ pathPattern: { values: [CMS_PATH_PATTERN] } }],
        actions: [
          {
            type: 'authenticate-oidc',
            authenticateOidc: {
              ...oidcAction(auth),
              // An editor mid-draft must get a 401 it can act on, not an HTML login page it will
              // try to parse as JSON.
              onUnauthenticatedRequest: 'deny',
            },
          },
          { type: 'forward', targetGroupArn: targetGroup.arn },
        ],
      },
      reparentedChild(this),
    );

    this.createCmsSignInRule(name, args);
  }

  /**
   * The one rule that will actually sign somebody in.
   *
   * Without it ALB mode cannot be entered at all, which is easy to miss: an ALB session cookie is
   * only ever issued by a rule whose action *authenticates*, and every other rule here denies. A
   * browser arriving with no cookie would be told 401 by the deny rule and given no way to fix it,
   * forever.
   *
   * So exactly one path redirects. It is narrow — a single exact path, evaluated before the deny
   * rule — because `authenticate` on anything broader would put an identity provider round trip in
   * front of API calls that should fail fast with a status a client can read.
   */
  private createCmsSignInRule(name: string, args: CmsAuthRuleArgs): void {
    const { auth, listener, targetGroup } = args;

    new aws.lb.ListenerRule(
      `${name}-cms-sign-in`,
      {
        listenerArn: listener.arn,
        priority: CMS_SIGN_IN_RULE_PRIORITY,
        conditions: [{ pathPattern: { values: [CMS_SIGN_IN_PATH] } }],
        actions: [
          {
            type: 'authenticate-oidc',
            authenticateOidc: { ...oidcAction(auth), onUnauthenticatedRequest: 'authenticate' },
          },
          { type: 'forward', targetGroupArn: targetGroup.arn },
        ],
      },
      reparentedChild(this),
    );
  }
}

/** The provider settings both rules share; only `onUnauthenticatedRequest` differs between them. */
function oidcAction(auth: CmsAlbAuthArgs) {
  return {
    issuer: auth.oidc.issuer,
    authorizationEndpoint: auth.oidc.authorizationEndpoint,
    tokenEndpoint: auth.oidc.tokenEndpoint,
    userInfoEndpoint: auth.oidc.userInfoEndpoint,
    clientId: auth.oidc.clientId,
    clientSecret: auth.clientSecret,
    scope: 'openid email profile',
  };
}

interface CmsAuthRuleArgs {
  readonly auth: CmsAlbAuthArgs;
  readonly listener: aws.lb.Listener;
  readonly targetGroup: aws.lb.TargetGroup;
}

interface ListenerArgs {
  readonly config: StackConfig;
  readonly alb: aws.lb.LoadBalancer;
  readonly targetGroup: aws.lb.TargetGroup;
}
