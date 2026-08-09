import { type IdentityResult } from './claims';

/** How the gateway is told who is calling. Selected by `AUTH_MODE`; see ADR 0013. */
export const AUTH_MODES = ['bearer', 'alb'] as const;

export type AuthMode = (typeof AUTH_MODES)[number];

/**
 * Reads one request header, case-insensitively.
 *
 * The verifiers take this rather than a Hono context so they can be unit-tested against a plain
 * object, and so neither of them depends on the HTTP framework.
 */
export type HeaderLookup = (name: string) => string | undefined;

/**
 * Establishes who is calling, from whatever the deployment's authentication puts on the request.
 *
 * Two implementations satisfy this: `createBearerVerifier` reads an OIDC access token the client
 * holds, and `createAlbVerifier` reads the JWT an ALB running `authenticate-oidc` signs on the
 * client's behalf. The rest of the service never learns which one is configured.
 */
export interface IdentityVerifier {
  readonly mode: AuthMode;
  verify(headers: HeaderLookup): Promise<IdentityResult>;
}
