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
const CMS_FORWARD_RULE_PRIORITY = 20;
const READER_SIGN_IN_RULE_PRIORITY = 30;
const READER_AUTH_RULE_PRIORITY = 40;

/** The editorial surface. Authenticated at the edge whenever `cmsAuthMode` is `alb`. */
const CMS_PATH_PATTERN = '/v1/cms/*';

/**
 * The reader surface, authenticated only when `readerAuthRequired` is on — off by default.
 *
 * Never the site itself. R22 is about who may spend a question and whose queries are logged, not
 * about who may read a page; every reader can already read every page, so putting an identity
 * provider redirect in front of the documentation would buy nothing. See ADR 0017.
 */
const READER_PATH_PATTERNS = ['/v1/ask', '/v1/search', '/v1/feedback'];

/**
 * Where a reader goes to obtain a session.
 *
 * `/v1/cms/identity` cannot serve this: it is mounted only when the CMS is configured, and a
 * deployment can authenticate readers without running one.
 */
const READER_SIGN_IN_PATH = '/v1/identity';

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
  /**
   * Create the editorial target group. Set when the CMS is configured at all — independently of
   * `cmsAuth`, which is only about ALB-mode authentication.
   */
  readonly cmsEnabled?: boolean | undefined;
  /** Present only in `cmsAuthMode: alb`, where the load balancer runs the OIDC exchange. */
  readonly cmsAuth?: CmsAlbAuthArgs | undefined;
  /**
   * Present only when readers must authenticate *and* the mode is `alb`. Absent — the default —
   * means not one listener rule below is created and the load balancer behaves exactly as it did
   * before R22 existed.
   */
  readonly readerAuth?: CmsAlbAuthArgs | undefined;
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
  /**
   * Resources the ECS service must exist *after*.
   *
   * A target group is not usable by a service until it is associated with a load balancer, and
   * ECS says so with a flat `does not have an associated load balancer` error. The association is
   * the listener rule, which nothing else in the graph connects to the service — Pulumi would
   * happily create them in parallel and lose the race some of the time.
   */
  public readonly routingDependencies: pulumi.Resource[] = [];

  /**
   * Editorial target group, present only when the CMS is configured.
   *
   * The service registers with both, so a task that cannot mint an installation token leaves this
   * one — and only this one — while continuing to serve readers. See {@link cmsTargetGroupArn}'s
   * health check for why that matters.
   */
  public readonly cmsTargetGroupArn: pulumi.Output<string> | undefined;
  public readonly url: pulumi.Output<string>;
  /** What `AUTH_MODE=alb` checks every token's `signer` header against — requirements.md R1. */
  public readonly loadBalancerArn: pulumi.Output<string>;

  constructor(name: string, args: GatewayIngressArgs, opts?: pulumi.ComponentResourceOptions) {
    super('lugem:net:GatewayIngress', name, {}, opts);

    const { config, network } = args;
    const listenerPort = config.certificateArn === undefined ? HTTP_PORT : HTTPS_PORT;

    const albSecurityGroup = this.createSecurityGroup(name, network.vpcId, listenerPort);

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

    // requirements.md R10: "a miscredentialed task never joins the target group". A single target
    // group could not honour that without also draining the reader site whenever the git host
    // blipped — so there are two. The public one asks "are you alive"; this one asks "can you
    // actually serve an author", and only `/v1/cms/*` is routed to it.
    //
    // It gates deploys as well as traffic: ECS waits for targets to become healthy in every
    // attached target group, so a deploy carrying an unusable App key never stabilises and the
    // circuit breaker rolls it back.
    const cmsTargetGroup =
      args.cmsEnabled === true ? this.createCmsTargetGroup(name, { config, network }) : undefined;

    const listener = this.createListeners(name, { config, alb, targetGroup });

    this.routingDependencies.push(listener);

    if (cmsTargetGroup !== undefined) {
      const rule = this.routeCmsTraffic(name, {
        listener,
        targetGroup: cmsTargetGroup,
        // `authenticate-oidc` is an HTTPS listener action, so without a certificate there is
        // nowhere to attach it. `github-config.ts` refuses that combination at preview; this
        // keeps the component correct if it is ever constructed directly.
        auth: config.certificateArn === undefined ? undefined : args.cmsAuth,
      });
      this.routingDependencies.push(rule);
    }

    // Same certificate prerequisite as the editorial rules, for the same reason: `authenticate-oidc`
    // is an HTTPS listener action. `github-config.ts` refuses the combination at preview.
    if (args.readerAuth !== undefined && config.certificateArn !== undefined) {
      this.createReaderAuthRules(name, {
        auth: args.readerAuth,
        listener,
        targetGroup,
      });
    }

    const scheme = config.certificateArn === undefined ? 'http' : 'https';

    this.albSecurityGroupId = albSecurityGroup.id;
    this.targetGroupArn = targetGroup.arn;
    this.cmsTargetGroupArn = cmsTargetGroup?.arn;
    this.loadBalancerArn = alb.arn;
    this.url = pulumi.interpolate`${scheme}://${alb.dnsName}`;

    this.registerOutputs({
      albSecurityGroupId: this.albSecurityGroupId,
      targetGroupArn: this.targetGroupArn,
      cmsTargetGroupArn: this.cmsTargetGroupArn,
      loadBalancerArn: this.loadBalancerArn,
      url: this.url,
    });
  }

  /** Client traffic in on the listener port, anything out to the tasks. */
  private createSecurityGroup(
    name: string,
    vpcId: pulumi.Input<string>,
    listenerPort: number,
  ): aws.ec2.SecurityGroup {
    return new aws.ec2.SecurityGroup(
      `${name}-alb-sg`,
      {
        vpcId,
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
  }

  /**
   * The target group that decides whether a task may serve *authors*.
   *
   * It probes `/readyz`, which mints an installation token, so requirements.md R10's "a
   * miscredentialed task never joins the target group" becomes literally true — for the surface
   * the requirement was written about. The public group keeps `/healthz`, so a git host outage
   * cannot drain the documentation site out from under readers who never needed the git host.
   *
   * It gates deploys too, which is the part worth knowing: ECS waits for targets to become
   * healthy in *every* attached group, so a rollout carrying an unwritten App key never
   * stabilises and `deploymentCircuitBreaker` rolls it back.
   */
  private createCmsTargetGroup(name: string, args: CmsTargetGroupArgs): aws.lb.TargetGroup {
    const { config, network } = args;

    return new aws.lb.TargetGroup(
      `${name}-cms-tg`,
      {
        port: config.containerPort,
        protocol: 'HTTP',
        targetType: 'ip',
        vpcId: network.vpcId,
        deregistrationDelay: DEREGISTRATION_DELAY_SECONDS,
        healthCheck: {
          path: '/readyz',
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
  }

  /** Sends `/v1/cms/*` to the editorial group, authenticating first in `alb` mode. */
  private routeCmsTraffic(name: string, args: CmsRoutingArgs): aws.lb.ListenerRule {
    const rule = new aws.lb.ListenerRule(
      `${name}-cms-forward`,
      {
        listenerArn: args.listener.arn,
        priority: CMS_FORWARD_RULE_PRIORITY,
        conditions: [{ pathPattern: { values: [CMS_PATH_PATTERN] } }],
        actions: [{ type: 'forward', targetGroupArn: args.targetGroup.arn }],
      },
      reparentedChild(this),
    );

    // In `alb` mode two higher-precedence rules authenticate first; both forward here as well.
    if (args.auth !== undefined) {
      this.createCmsAuthRule(name, {
        auth: args.auth,
        listener: args.listener,
        targetGroup: args.targetGroup,
      });
    }

    return rule;
  }

  /**
   * HTTPS when a certificate is configured, HTTP otherwise.
   *
   * Plain HTTP is the demo default because requiring a certificate would make the stack
   * undeployable without a domain. Any real deployment should set `certificateArn`.
   */
  private createListeners(name: string, args: ListenerArgs): aws.lb.Listener {
    const { config, alb, targetGroup } = args;
    const forward = [{ type: 'forward', targetGroupArn: targetGroup.arn }];

    if (config.certificateArn === undefined) {
      // Returned so rules can attach here too. Without a certificate there is no HTTPS listener,
      // and the editorial routing still has to work — only `authenticate-oidc` needs HTTPS, which
      // is why `cmsAuthMode: alb` is refused at preview when no certificate is configured.
      return new aws.lb.Listener(
        `${name}-http`,
        {
          loadBalancerArn: alb.arn,
          port: HTTP_PORT,
          protocol: 'HTTP',
          defaultActions: forward,
        },
        reparentedChild(this),
      );
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
              // `allow`, not `deny`, and this is the one setting on the page worth arguing about.
              //
              // `deny` returns 401 for a request carrying no authentication at all — but AWS
              // documents that an *expired* session is redirected to the identity provider
              // instead. An editor whose session lapsed mid-draft would then get a 302 into an
              // HTML login page, which their client tries to parse as JSON. R1 asks for a 401,
              // and `deny` cannot promise one for the case that actually happens.
              //
              // `allow` forwards without authentication information, and `alb-verifier.ts`
              // answers 401 with a reason. It always could: the rule was only ever defence in
              // depth, and the service check is the authority. The interactive redirect still
              // exists, on the single sign-in path — see `createCmsSignInRule`.
              onUnauthenticatedRequest: 'allow',
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
  /**
   * Reader authentication at the edge, mirroring the editorial rules exactly.
   *
   * Both forward to the **public** target group, never the editorial one: that group probes
   * `/readyz`, which mints a GitHub App installation token readers have no business depending on.
   *
   * These use plain `{ parent: this }` rather than `reparentedChild`, unlike their siblings in this
   * file. The siblings predate the component refactor and carry an alias to a URN they once had;
   * these never existed at the root, so an alias would point at nothing. See `child-options.ts`.
   */
  private createReaderAuthRules(name: string, args: CmsAuthRuleArgs): void {
    const { auth, listener, targetGroup } = args;

    // The one reader path that redirects. Without it a browser with no cookie is told 401 forever
    // and given no way to fix it — the same trap `createCmsSignInRule` exists to avoid.
    new aws.lb.ListenerRule(
      `${name}-reader-sign-in`,
      {
        listenerArn: listener.arn,
        priority: READER_SIGN_IN_RULE_PRIORITY,
        conditions: [{ pathPattern: { values: [READER_SIGN_IN_PATH] } }],
        actions: [
          {
            type: 'authenticate-oidc',
            authenticateOidc: { ...oidcAction(auth), onUnauthenticatedRequest: 'authenticate' },
          },
          { type: 'forward', targetGroupArn: targetGroup.arn },
        ],
      },
      { parent: this },
    );

    new aws.lb.ListenerRule(
      `${name}-reader-auth`,
      {
        listenerArn: listener.arn,
        priority: READER_AUTH_RULE_PRIORITY,
        conditions: [{ pathPattern: { values: READER_PATH_PATTERNS } }],
        actions: [
          {
            type: 'authenticate-oidc',
            // `allow`, for the reason spelled out on the editorial rule: an *expired* session under
            // `deny` is redirected to the identity provider, and the widget's `fetch` would try to
            // parse an HTML login page as JSON. Under `allow` the gateway answers a JSON 401 the
            // client can act on, and `AskWidget` renders a sign-in link.
            authenticateOidc: { ...oidcAction(auth), onUnauthenticatedRequest: 'allow' },
          },
          { type: 'forward', targetGroupArn: targetGroup.arn },
        ],
      },
      { parent: this },
    );
  }

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

/** The provider settings every rule shares; only `onUnauthenticatedRequest` differs between them. */
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

interface CmsTargetGroupArgs {
  readonly config: StackConfig;
  readonly network: Network;
}

interface CmsRoutingArgs {
  readonly listener: aws.lb.Listener;
  readonly targetGroup: aws.lb.TargetGroup;
  /** Present only in `alb` mode, and only meaningful with an HTTPS listener. */
  readonly auth: CmsAlbAuthArgs | undefined;
}

interface ListenerArgs {
  readonly config: StackConfig;
  readonly alb: aws.lb.LoadBalancer;
  readonly targetGroup: aws.lb.TargetGroup;
}
