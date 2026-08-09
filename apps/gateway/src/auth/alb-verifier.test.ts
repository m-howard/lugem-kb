import { base64url } from 'jose';
import { describe, expect, it } from 'vitest';

import { createAlbVerifier } from './alb-verifier';
import { type FakeAlbSigner, fakeAlbSigner } from '../../tests/helpers/fake-idp';
import { requestUrl } from '../../tests/helpers/request-url';

const CLAIM_NAMES = { email: 'email', name: 'name' };
const REGION = 'us-east-1';
const SUBJECT = { sub: 'a1b2', email: 'sam@example.com', name: 'Sam Okoro' };
const KEY_BASE_URL = 'https://public-keys.test';

function headers(map: Record<string, string>) {
  return (name: string) => map[name.toLowerCase()];
}

function verifierFor(alb: FakeAlbSigner, loadBalancerArn = alb.loadBalancerArn) {
  return createAlbVerifier({
    region: REGION,
    loadBalancerArn,
    claimNames: CLAIM_NAMES,
    publicKeys: { baseUrl: KEY_BASE_URL, fetch: alb.fetch },
  });
}

/** A syntactically valid JWT with an arbitrary header, for cases no real signer would produce. */
function craftToken(header: Record<string, unknown>): string {
  const encode = (value: unknown) => base64url.encode(JSON.stringify(value));
  return `${encode(header)}.${encode({ sub: 'a1b2' })}.${base64url.encode('signature')}`;
}

describe('createAlbVerifier', () => {
  it('accepts a token signed by the configured load balancer', async () => {
    const alb = await fakeAlbSigner();

    const result = await verifierFor(alb).verify(
      headers({ 'x-amzn-oidc-data': await alb.sign(SUBJECT) }),
    );

    expect(result).toMatchObject({ ok: true, identity: { email: 'sam@example.com' } });
  });

  describe('refuses', () => {
    it('a request with no x-amzn-oidc-data header', async () => {
      const alb = await fakeAlbSigner();

      expect(await verifierFor(alb).verify(headers({}))).toMatchObject({
        ok: false,
        reason: 'missing-credential',
      });
    });

    it('a header that is not a JWT', async () => {
      const alb = await fakeAlbSigner();

      expect(await verifierFor(alb).verify(headers({ 'x-amzn-oidc-data': 'garbage' }))).toMatchObject(
        { ok: false, reason: 'malformed-credential' },
      );
    });

    // The header alone is not a credential: anything that can reach the task can set it. A token
    // from a real, correctly-signing load balancer that is not *ours* must still be refused.
    it('a validly signed token from another load balancer', async () => {
      const alb = await fakeAlbSigner();
      const token = await alb.sign(SUBJECT, {
        signer: 'arn:aws:elasticloadbalancing:us-east-1:999988887777:loadbalancer/app/evil/def456',
      });

      expect(await verifierFor(alb).verify(headers({ 'x-amzn-oidc-data': token }))).toMatchObject({
        ok: false,
        reason: 'untrusted-signer',
      });
    });

    it('a token nominating an algorithm the ALB never signs with', async () => {
      const alb = await fakeAlbSigner();
      const token = craftToken({ alg: 'none', kid: alb.keyId, signer: alb.loadBalancerArn });

      expect(await verifierFor(alb).verify(headers({ 'x-amzn-oidc-data': token }))).toMatchObject({
        ok: false,
        reason: 'malformed-credential',
      });
    });

    it('a token whose signature does not check out', async () => {
      const alb = await fakeAlbSigner();
      const token = await alb.sign(SUBJECT);
      const tampered = `${token.slice(0, -4)}AAAA`;

      expect(await verifierFor(alb).verify(headers({ 'x-amzn-oidc-data': tampered }))).toMatchObject(
        { ok: false, reason: 'invalid-signature' },
      );
    });

    it('a token whose key id the endpoint does not serve', async () => {
      const alb = await fakeAlbSigner();
      const token = craftToken({ alg: 'ES256', kid: 'unknown', signer: alb.loadBalancerArn });

      expect(await verifierFor(alb).verify(headers({ 'x-amzn-oidc-data': token }))).toMatchObject({
        ok: false,
        reason: 'invalid-signature',
      });
    });

    it('a verified token that carries no email claim', async () => {
      const alb = await fakeAlbSigner();
      const token = await alb.sign({ sub: 'a1b2' });

      expect(await verifierFor(alb).verify(headers({ 'x-amzn-oidc-data': token }))).toMatchObject({
        ok: false,
        reason: 'missing-email',
      });
    });
  });

  // Checking the signer before fetching a key is what keeps the key cache bounded: a forged token
  // naming an arbitrary key id never reaches the network.
  it('makes no key request for a token from the wrong signer', async () => {
    const alb = await fakeAlbSigner();
    const requested: string[] = [];
    const verifier = createAlbVerifier({
      region: REGION,
      loadBalancerArn: alb.loadBalancerArn,
      claimNames: CLAIM_NAMES,
      publicKeys: {
        baseUrl: KEY_BASE_URL,
        fetch: ((input: string | URL | Request) => {
          requested.push(requestUrl(input));
          return alb.fetch(input);
        }) as typeof globalThis.fetch,
      },
    });

    await verifier.verify(
      headers({ 'x-amzn-oidc-data': craftToken({ alg: 'ES256', kid: '../../etc', signer: 'other' }) }),
    );

    expect(requested).toEqual([]);
  });

  it('fetches each key once and reuses it', async () => {
    const alb = await fakeAlbSigner();
    const requested: string[] = [];
    const verifier = createAlbVerifier({
      region: REGION,
      loadBalancerArn: alb.loadBalancerArn,
      claimNames: CLAIM_NAMES,
      publicKeys: {
        baseUrl: KEY_BASE_URL,
        fetch: ((input: string | URL | Request) => {
          requested.push(requestUrl(input));
          return alb.fetch(input);
        }) as typeof globalThis.fetch,
      },
    });

    const token = await alb.sign(SUBJECT);
    await verifier.verify(headers({ 'x-amzn-oidc-data': token }));
    await verifier.verify(headers({ 'x-amzn-oidc-data': token }));

    expect(requested).toEqual([`${KEY_BASE_URL}/${alb.keyId}`]);
  });
});
