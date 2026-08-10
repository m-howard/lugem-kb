import { describe, expect, it } from 'vitest';

import { createVerifier } from './dependencies';
import { type AuthConfig } from '../config';

const CLAIMS = { emailClaim: 'email', nameClaim: 'name' };
const REGION = 'us-east-1';

describe('createVerifier', () => {
  // The one place the two auth modes are chosen. Everything downstream is written against the
  // IdentityVerifier interface and never learns which is deployed — ADR 0013.
  it('builds a bearer verifier in bearer mode', () => {
    const auth: AuthConfig = {
      ...CLAIMS,
      mode: 'bearer',
      issuer: 'https://idp.example.com/realm',
      audience: 'lugem-cms',
      clientId: 'lugem-cms-admin',
    };

    expect(createVerifier(auth, REGION).mode).toBe('bearer');
  });

  it('builds an ALB verifier in alb mode', () => {
    const auth: AuthConfig = {
      ...CLAIMS,
      mode: 'alb',
      loadBalancerArn: 'arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/l/1',
    };

    expect(createVerifier(auth, REGION).mode).toBe('alb');
  });

  it('refuses an unauthenticated request in either mode, without a network call', async () => {
    const bearer = createVerifier(
      {
        ...CLAIMS,
        mode: 'bearer',
        issuer: 'https://idp.example.com',
        audience: 'lugem-cms',
        clientId: 'a',
      },
      REGION,
    );
    const alb = createVerifier({ ...CLAIMS, mode: 'alb', loadBalancerArn: 'arn:aws:x' }, REGION);
    const noHeaders = () => undefined;

    await expect(bearer.verify(noHeaders)).resolves.toMatchObject({
      ok: false,
      reason: 'missing-credential',
    });
    await expect(alb.verify(noHeaders)).resolves.toMatchObject({
      ok: false,
      reason: 'missing-credential',
    });
  });
});
