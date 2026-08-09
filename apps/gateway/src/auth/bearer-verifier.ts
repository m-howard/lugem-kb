import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

import {
  type ClaimNames,
  identityFromClaims,
  type IdentityRefusalReason,
  type IdentityResult,
  refuseIdentity,
} from './claims';
import { type HeaderLookup, type IdentityVerifier } from './verifier';

const BEARER_SCHEME = 'bearer ';

/**
 * Maps `jose`'s error codes onto the closed refusal set.
 *
 * Matching on `code` rather than on the error class keeps this working across a `jose` upgrade
 * that reorganises its error hierarchy, which an `instanceof` chain would not survive.
 */
const REFUSAL_BY_JOSE_CODE: Readonly<Record<string, IdentityRefusalReason>> = {
  ERR_JWT_EXPIRED: 'expired',
  ERR_JWS_SIGNATURE_VERIFICATION_FAILED: 'invalid-signature',
  ERR_JWKS_NO_MATCHING_KEY: 'invalid-signature',
  ERR_JWKS_MULTIPLE_MATCHING_KEYS: 'invalid-signature',
};

/** A failed claim check is not one reason. A wrong audience and a wrong issuer are different events. */
const REFUSAL_BY_FAILED_CLAIM: Readonly<Record<string, IdentityRefusalReason>> = {
  aud: 'wrong-audience',
  iss: 'untrusted-signer',
  exp: 'expired',
};

export interface BearerVerifierOptions {
  /** OIDC issuer. Its discovery document names the key set, so no key is configured by hand. */
  readonly issuer: string;
  readonly audience: string;
  readonly claimNames: ClaimNames;
  /**
   * Skips discovery and verifies against this key set instead.
   *
   * Tests pass `createLocalJWKSet` over a generated key pair, so verification is real without a
   * network. A provider that publishes no discovery document can use the same seam.
   */
  readonly keyResolver?: JWTVerifyGetKey | undefined;
  /** Test seam for the discovery request. */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

function refusalFor(error: unknown): IdentityRefusalReason {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return 'malformed-credential';
  }
  if (error.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && 'claim' in error) {
    return REFUSAL_BY_FAILED_CLAIM[String(error.claim)] ?? 'malformed-credential';
  }
  return REFUSAL_BY_JOSE_CODE[String(error.code)] ?? 'malformed-credential';
}

function bearerToken(headers: HeaderLookup): string | undefined {
  const header = headers('authorization')?.trim();
  if (header?.toLowerCase().startsWith(BEARER_SCHEME) !== true) {
    return undefined;
  }
  const token = header.slice(BEARER_SCHEME.length).trim();
  return token === '' ? undefined : token;
}

/**
 * Discovers the issuer's key set, once — but caches only success.
 *
 * Discovery is lazy rather than done at start-up on purpose: an identity provider that is briefly
 * unreachable should fail readiness, not stop the process from booting at all.
 *
 * Which makes clearing the cache on failure the other half of that decision. Memoising the
 * rejected promise would turn one unlucky moment — the first author of the day arriving during a
 * provider blip — into every author being refused until someone restarts the service, long after
 * the provider recovered. `createAppKeyLoader` in `git/app-key.ts` takes the same care, for the
 * same reason.
 */
function discoverKeyResolver(options: BearerVerifierOptions): () => Promise<JWTVerifyGetKey> {
  const request = options.fetch ?? globalThis.fetch;
  let resolver: Promise<JWTVerifyGetKey> | undefined;

  return () => {
    resolver ??= (async () => {
      const issuer = options.issuer.replace(/\/+$/, '');
      try {
        const response = await request(`${issuer}/.well-known/openid-configuration`);
        if (!response.ok) {
          throw new Error(
            `OIDC discovery for ${issuer} returned ${String(response.status)}. ` +
              'Check AUTH_ISSUER_URL, or configure the key set directly.',
          );
        }
        const document = (await response.json()) as { jwks_uri?: unknown };
        if (typeof document.jwks_uri !== 'string') {
          throw new Error(`OIDC discovery for ${issuer} returned no jwks_uri.`);
        }
        return createRemoteJWKSet(new URL(document.jwks_uri));
      } catch (error) {
        resolver = undefined;
        throw error;
      }
    })();
    return resolver;
  };
}

/**
 * Verifies an OIDC access token the client presents as `Authorization: Bearer`.
 *
 * This is the mode that needs no load balancer involvement, so it is the one a scripted client can
 * drive — which is what the Phase 2 exit criterion asks for. See ADR 0013.
 *
 * @param options - Issuer, audience, claim names, and optional key-set and fetch seams.
 * @returns A verifier that refuses anything it cannot attribute, without an upstream call.
 */
export function createBearerVerifier(options: BearerVerifierOptions): IdentityVerifier {
  const keyResolver = discoverKeyResolver(options);

  return {
    mode: 'bearer',
    async verify(headers: HeaderLookup): Promise<IdentityResult> {
      const token = bearerToken(headers);
      if (token === undefined) {
        return refuseIdentity('missing-credential', 'No bearer token was presented.');
      }

      try {
        const { payload } = await jwtVerify(token, options.keyResolver ?? (await keyResolver()), {
          issuer: options.issuer,
          audience: options.audience,
        });
        return identityFromClaims(payload, options.claimNames);
      } catch (error) {
        return refuseIdentity(
          refusalFor(error),
          error instanceof Error ? error.message : 'The bearer token could not be verified.',
        );
      }
    },
  };
}
