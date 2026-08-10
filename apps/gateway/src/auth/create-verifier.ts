import { createAlbVerifier } from './alb-verifier';
import { createBearerVerifier } from './bearer-verifier';
import { type IdentityVerifier } from './verifier';
import { type AuthConfig } from '../config';

/**
 * Builds the verifier for the configured mode (requirements.md R1; ADR 0013).
 *
 * The two modes are chosen here and nowhere else, so the rest of the service is written against
 * one interface and never learns which is deployed.
 *
 * @param auth - The resolved auth configuration.
 * @param region - Region of the load balancer, used only in `alb` mode.
 * @returns The verifier.
 */
export function createVerifier(auth: AuthConfig, region: string): IdentityVerifier {
  const claimNames = { email: auth.emailClaim, name: auth.nameClaim };

  if (auth.mode === 'alb') {
    return createAlbVerifier({ region, loadBalancerArn: auth.loadBalancerArn, claimNames });
  }
  return createBearerVerifier({ issuer: auth.issuer, audience: auth.audience, claimNames });
}
