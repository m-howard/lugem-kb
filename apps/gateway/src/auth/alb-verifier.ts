import { type CryptoKey, decodeProtectedHeader, importSPKI, jwtVerify } from 'jose';

import {
  type ClaimNames,
  identityFromClaims,
  type IdentityResult,
  refuseIdentity,
} from './claims';
import { type HeaderLookup, type IdentityVerifier } from './verifier';

/** The header an ALB running `authenticate-oidc` adds. Signed, so it is a credential — see `logging.ts`. */
const OIDC_DATA_HEADER = 'x-amzn-oidc-data';

/**
 * The only algorithm an ALB signs with.
 *
 * Pinned rather than read from the token. Letting a credential nominate the algorithm it should be
 * checked with is how `alg: none` and RS256-verified-as-HMAC both work.
 */
const ALB_SIGNING_ALGORITHM = 'ES256';

export interface AlbVerifierOptions {
  /** Region of the load balancer, and so of the key endpoint. Never taken from the token. */
  readonly region: string;
  /** ARN the token's `signer` header must equal. */
  readonly loadBalancerArn: string;
  readonly claimNames: ClaimNames;
  /** Test seam: base URL of the public key endpoint, and the fetch used to read it. */
  readonly publicKeys?: { readonly baseUrl?: string; readonly fetch?: typeof globalThis.fetch };
}

interface AlbTokenHeader {
  readonly kid: string;
  readonly signer: string;
  readonly alg: string;
}

function readTokenHeader(token: string): AlbTokenHeader | undefined {
  try {
    const header = decodeProtectedHeader(token);
    const { kid, alg } = header;
    const signer = (header as { signer?: unknown }).signer;
    if (typeof kid !== 'string' || typeof alg !== 'string' || typeof signer !== 'string') {
      return undefined;
    }
    return { kid, signer, alg };
  } catch {
    return undefined;
  }
}

/**
 * Fetches and caches the ALB's public keys by key id.
 *
 * Only reached after the signer has been checked, so a forged token cannot make the gateway fetch
 * an arbitrary key id — which is also what keeps this cache bounded.
 */
function createKeyCache(options: AlbVerifierOptions): (kid: string) => Promise<CryptoKey> {
  const request = options.publicKeys?.fetch ?? globalThis.fetch;
  const baseUrl =
    options.publicKeys?.baseUrl ?? `https://public-keys.auth.elb.${options.region}.amazonaws.com`;
  const keys = new Map<string, Promise<CryptoKey>>();

  return (kid: string) => {
    const cached = keys.get(kid);
    if (cached !== undefined) {
      return cached;
    }

    const pending = (async () => {
      const response = await request(`${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(kid)}`);
      if (!response.ok) {
        keys.delete(kid);
        throw new Error(`ALB public key ${kid} returned ${String(response.status)}.`);
      }
      return importSPKI(await response.text(), ALB_SIGNING_ALGORITHM);
    })();

    keys.set(kid, pending);
    return pending;
  };
}

/**
 * Verifies the JWT an ALB running `authenticate-oidc` puts on a request.
 *
 * The header alone is not a credential — anything that can reach the task could set it. What makes
 * it one is the signature plus the `signer` check: the token must be signed by *our* load
 * balancer, not by any load balancer in the region. Checking the signer before fetching a key also
 * means a forged token costs no network call. See ADR 0013.
 *
 * @param options - Region, expected load balancer ARN, claim names, and the key-endpoint seam.
 * @returns A verifier that refuses anything it cannot attribute.
 */
export function createAlbVerifier(options: AlbVerifierOptions): IdentityVerifier {
  const publicKey = createKeyCache(options);

  return {
    mode: 'alb',
    async verify(headers: HeaderLookup): Promise<IdentityResult> {
      const token = headers(OIDC_DATA_HEADER)?.trim();
      if (token === undefined || token === '') {
        return refuseIdentity('missing-credential', `No ${OIDC_DATA_HEADER} header was present.`);
      }

      const header = readTokenHeader(token);
      if (header === undefined) {
        return refuseIdentity('malformed-credential', `The ${OIDC_DATA_HEADER} header is not a JWT.`);
      }
      if (header.signer !== options.loadBalancerArn) {
        return refuseIdentity(
          'untrusted-signer',
          `Signed by ${header.signer}, which is not this service's load balancer.`,
        );
      }
      if (header.alg !== ALB_SIGNING_ALGORITHM) {
        return refuseIdentity('malformed-credential', `Unexpected algorithm ${header.alg}.`);
      }

      try {
        const { payload } = await jwtVerify(token, await publicKey(header.kid), {
          algorithms: [ALB_SIGNING_ALGORITHM],
        });
        return identityFromClaims(payload, options.claimNames);
      } catch (error) {
        return refuseIdentity(
          'invalid-signature',
          error instanceof Error ? error.message : 'The ALB token could not be verified.',
        );
      }
    },
  };
}
