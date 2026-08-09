import { describe, expect, it } from 'vitest';

import { createBearerVerifier } from './bearer-verifier';
import { type IdentityVerifier } from './verifier';
import { type FakeIdp, fakeIdp } from '../../tests/helpers/fake-idp';
import { requestUrl } from '../../tests/helpers/request-url';

const CLAIM_NAMES = { email: 'email', name: 'name' };
const SUBJECT = { sub: 'a1b2', email: 'sam@example.com', name: 'Sam Okoro' };

function headers(map: Record<string, string>) {
  return (name: string) => map[name.toLowerCase()];
}

function verifierFor(idp: FakeIdp): IdentityVerifier {
  return createBearerVerifier({
    issuer: idp.issuer,
    audience: idp.audience,
    claimNames: CLAIM_NAMES,
    keyResolver: idp.keyResolver,
  });
}

describe('createBearerVerifier', () => {
  it('accepts a token signed by the configured issuer', async () => {
    const idp = await fakeIdp();
    const verifier = verifierFor(idp);

    const result = await verifier.verify(
      headers({ authorization: `Bearer ${await idp.sign(SUBJECT)}` }),
    );

    expect(result).toMatchObject({ ok: true, identity: { email: 'sam@example.com' } });
  });

  it('accepts the scheme in any case, as RFC 7235 requires', async () => {
    const idp = await fakeIdp();
    const verifier = verifierFor(idp);

    const result = await verifier.verify(
      headers({ authorization: `bEaReR ${await idp.sign(SUBJECT)}` }),
    );

    expect(result.ok).toBe(true);
  });

  // Each row is an acceptance criterion from requirements.md R1: a request the gateway cannot
  // attribute is refused, and the reasons stay distinct so the audit log can tell a
  // misconfiguration from an attack.
  describe('refuses', () => {
    it('a request with no Authorization header', async () => {
      const verifier = verifierFor(await fakeIdp());

      expect(await verifier.verify(headers({}))).toMatchObject({
        ok: false,
        reason: 'missing-credential',
      });
    });

    it.each([
      ['another scheme', 'Basic c2FtOnN3b3JkZmlzaA=='],
      ['an empty bearer token', 'Bearer '],
    ])('%s', async (_case, header) => {
      const verifier = verifierFor(await fakeIdp());

      expect(await verifier.verify(headers({ authorization: header }))).toMatchObject({
        ok: false,
        reason: 'missing-credential',
      });
    });

    it('a token that is not a JWT', async () => {
      const verifier = verifierFor(await fakeIdp());

      expect(await verifier.verify(headers({ authorization: 'Bearer not.a.jwt' }))).toMatchObject({
        ok: false,
        reason: 'malformed-credential',
      });
    });

    it('an expired token', async () => {
      const idp = await fakeIdp();
      const verifier = verifierFor(idp);
      const token = await idp.sign(SUBJECT, { expiresInSeconds: -60 });

      expect(await verifier.verify(headers({ authorization: `Bearer ${token}` }))).toMatchObject({
        ok: false,
        reason: 'expired',
      });
    });

    it('a token minted for another audience', async () => {
      const idp = await fakeIdp();
      const verifier = verifierFor(idp);
      const token = await idp.sign(SUBJECT, { audience: 'some-other-app' });

      expect(await verifier.verify(headers({ authorization: `Bearer ${token}` }))).toMatchObject({
        ok: false,
        reason: 'wrong-audience',
      });
    });

    it('a token from another issuer', async () => {
      const idp = await fakeIdp();
      const verifier = verifierFor(idp);
      const token = await idp.sign(SUBJECT, { issuer: 'https://idp.evil/realm' });

      expect(await verifier.verify(headers({ authorization: `Bearer ${token}` }))).toMatchObject({
        ok: false,
        reason: 'untrusted-signer',
      });
    });

    // The signature is real, so this is the case that would pass if verification were stubbed.
    it('a token signed by a key the issuer does not publish', async () => {
      const impostor = await fakeIdp();
      const verifier = verifierFor(await fakeIdp());
      const token = await impostor.sign(SUBJECT);

      expect(await verifier.verify(headers({ authorization: `Bearer ${token}` }))).toMatchObject({
        ok: false,
        reason: 'invalid-signature',
      });
    });

    it('a verified token that carries no email claim', async () => {
      const idp = await fakeIdp();
      const verifier = verifierFor(idp);
      const token = await idp.sign({ sub: 'a1b2' });

      expect(await verifier.verify(headers({ authorization: `Bearer ${token}` }))).toMatchObject({
        ok: false,
        reason: 'missing-email',
      });
    });
  });

  describe('discovery', () => {
    it('reads jwks_uri from the issuer when no key set is configured', async () => {
      const idp = await fakeIdp();
      const requested: string[] = [];
      const verifier = createBearerVerifier({
        issuer: `${idp.issuer}/`,
        audience: idp.audience,
        claimNames: CLAIM_NAMES,
        fetch: ((input: string | URL | Request) => {
          requested.push(requestUrl(input));
          return Promise.resolve(Response.json({ jwks_uri: 'https://idp.test/keys' }));
        }) as typeof globalThis.fetch,
      });

      // Verification itself fails — nothing serves https://idp.test/keys — but discovery has run,
      // which is what this asserts. A trailing slash on the issuer must not double up.
      await verifier.verify(headers({ authorization: `Bearer ${await idp.sign(SUBJECT)}` }));

      expect(requested).toEqual(['https://idp.test/realm/.well-known/openid-configuration']);
    });

    it('refuses rather than throwing when discovery fails', async () => {
      const idp = await fakeIdp();
      const verifier = createBearerVerifier({
        issuer: idp.issuer,
        audience: idp.audience,
        claimNames: CLAIM_NAMES,
        fetch: ((_input: string | URL | Request) =>
          Promise.resolve(new Response('nope', { status: 503 }))) as typeof globalThis.fetch,
      });

      const result = await verifier.verify(
        headers({ authorization: `Bearer ${await idp.sign(SUBJECT)}` }),
      );

      expect(result).toMatchObject({ ok: false, reason: 'malformed-credential' });
    });
  });
});
