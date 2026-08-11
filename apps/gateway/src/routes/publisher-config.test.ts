import { describe, expect, it } from 'vitest';

import { createPublisherConfigRoutes } from './publisher-config';
import { type AuthConfig } from '../config';

const CLAIMS = { emailClaim: 'email', nameClaim: 'name' };

const BEARER: AuthConfig = {
  ...CLAIMS,
  mode: 'bearer',
  issuer: 'https://idp.example.com/realm',
  audience: 'api://lugem-cms',
  clientId: 'lugem-cms-admin',
};

const ALB: AuthConfig = {
  ...CLAIMS,
  mode: 'alb',
  loadBalancerArn: 'arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/l/1',
};

async function config(auth: AuthConfig): Promise<Record<string, unknown>> {
  const response = await createPublisherConfigRoutes({ auth }).request('/config');

  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

describe('createPublisherConfigRoutes', () => {
  // Everything served here is an OIDC public-client parameter — it travels in the browser's own
  // redirect URL either way. The endpoint is unauthenticated because the page that needs it is by
  // definition the page with no token yet.
  it('tells the admin page how to start a bearer sign-in', async () => {
    await expect(config(BEARER)).resolves.toEqual({
      authMode: 'bearer',
      issuer: 'https://idp.example.com/realm',
      clientId: 'lugem-cms-admin',
      audience: 'api://lugem-cms',
      scopes: 'openid profile email',
    });
  });

  // In alb mode the load balancer issues a session cookie, and only the sign-in rule does. The
  // page is told where that is rather than being left to guess.
  it('points at the sign-in path in alb mode', async () => {
    await expect(config(ALB)).resolves.toEqual({
      authMode: 'alb',
      signInPath: '/v1/cms/identity',
    });
  });

  it('never publishes the load balancer ARN', async () => {
    expect(JSON.stringify(await config(ALB))).not.toContain('arn:aws');
  });

  // The claim names are how the gateway reads a token, not how a browser obtains one. Publishing
  // them would say more about the deployment than an anonymous caller needs to know.
  it.each([
    ['bearer', BEARER],
    ['alb', ALB],
  ])('does not publish the claim configuration in %s mode', async (_case, auth) => {
    const body = await config(auth);

    expect(body['emailClaim']).toBeUndefined();
    expect(body['nameClaim']).toBeUndefined();
  });

  it('answers nothing for a path it does not serve', async () => {
    const response = await createPublisherConfigRoutes({ auth: BEARER }).request('/secrets');

    expect(response.status).toBe(404);
  });
});
