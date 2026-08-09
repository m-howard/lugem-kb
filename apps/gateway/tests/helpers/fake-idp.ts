import {
  createLocalJWKSet,
  exportJWK,
  exportSPKI,
  generateKeyPair,
  type JWK,
  type JWTVerifyGetKey,
  SignJWT,
} from 'jose';

import { requestUrl } from './request-url';

/**
 * Real key material, generated per test run.
 *
 * The alternative — stubbing `jwtVerify` — would leave the thing these tests exist to prove
 * untested: that a token this service accepts is one it actually verified. Generating a key pair
 * costs milliseconds and keeps the signature real, in the same spirit as `fake-aws.ts` faking the
 * client rather than mocking the module.
 */
export interface FakeIdp {
  readonly issuer: string;
  readonly audience: string;
  readonly keyResolver: JWTVerifyGetKey;
  /** Mints a signed token. Overrides let a test move `exp`, change `aud`, or drop a claim. */
  sign(claims: Record<string, unknown>, options?: FakeTokenOptions): Promise<string>;
}

export interface FakeTokenOptions {
  readonly issuer?: string;
  readonly audience?: string;
  /** Seconds from now. Negative mints an already-expired token. */
  readonly expiresInSeconds?: number;
}

const DEFAULT_ISSUER = 'https://idp.test/realm';
const DEFAULT_AUDIENCE = 'lugem-cms';
const DEFAULT_EXPIRY_SECONDS = 300;
const MS_PER_SECOND = 1000;
const KEY_ID = 'test-key-1';

/**
 * An in-memory OIDC issuer: one RS256 key pair, a local key set, and a signer.
 *
 * @returns The issuer, its key resolver, and a `sign` helper.
 */
export async function fakeIdp(): Promise<FakeIdp> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: KEY_ID, alg: 'RS256', use: 'sig' } as JWK;

  return {
    issuer: DEFAULT_ISSUER,
    audience: DEFAULT_AUDIENCE,
    keyResolver: createLocalJWKSet({ keys: [jwk] }),
    async sign(claims, options = {}) {
      const now = Math.floor(Date.now() / MS_PER_SECOND);
      return new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
        .setIssuer(options.issuer ?? DEFAULT_ISSUER)
        .setAudience(options.audience ?? DEFAULT_AUDIENCE)
        .setIssuedAt(now)
        .setExpirationTime(now + (options.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS))
        .sign(privateKey);
    },
  };
}

/** A load balancer's signing key, plus the endpoint that serves its public half by key id. */
export interface FakeAlbSigner {
  readonly loadBalancerArn: string;
  readonly keyId: string;
  readonly publicKeyPem: string;
  /** Stands in for `https://public-keys.auth.elb.<region>.amazonaws.com`. */
  readonly fetch: typeof globalThis.fetch;
  sign(claims: Record<string, unknown>, options?: FakeAlbTokenOptions): Promise<string>;
}

export interface FakeAlbTokenOptions {
  /** Written into the `signer` header. A different ARN is what an impostor load balancer looks like. */
  readonly signer?: string;
  readonly expiresInSeconds?: number;
}

const ALB_ARN = 'arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/lugem/abc123';
const ALB_KEY_ID = 'a1b2c3d4-0000-1111-2222-333344445555';
const NOT_FOUND = 404;

/**
 * An in-memory stand-in for an ALB running `authenticate-oidc`.
 *
 * `signer` and the algorithm are overridable because both are attack surface: the verifier's job
 * is to refuse a validly-signed token from the wrong load balancer, and that cannot be asserted
 * without minting one.
 *
 * @returns The signer, its ARN and key id, and a `fetch` serving the public key.
 */
export async function fakeAlbSigner(): Promise<FakeAlbSigner> {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const publicKeyPem = await exportSPKI(publicKey);

  return {
    loadBalancerArn: ALB_ARN,
    keyId: ALB_KEY_ID,
    publicKeyPem,
    fetch: ((input: string | URL | Request) => {
      const url = requestUrl(input);
      return Promise.resolve(
        url.endsWith(`/${ALB_KEY_ID}`)
          ? new Response(publicKeyPem)
          : new Response('no such key', { status: NOT_FOUND }),
      );
    }) as typeof globalThis.fetch,
    async sign(claims, options = {}) {
      const now = Math.floor(Date.now() / MS_PER_SECOND);
      return new SignJWT(claims)
        .setProtectedHeader({ alg: 'ES256', kid: ALB_KEY_ID, signer: options.signer ?? ALB_ARN })
        .setIssuedAt(now)
        .setExpirationTime(now + (options.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS))
        .sign(privateKey);
    },
  };
}
