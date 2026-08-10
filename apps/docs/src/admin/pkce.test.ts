import { describe, expect, it } from 'vitest';

import {
  buildAuthorizeUrl,
  codeChallenge,
  createCodeVerifier,
  createState,
  parseCallback,
} from './pkce';

const AUTHORIZE = 'https://idp.example.com/authorize';

const PARAMS = {
  clientId: 'lugem-cms-admin',
  redirectUri: 'https://docs.internal/admin/',
  scopes: 'openid profile email',
  state: 'state-1',
  challenge: 'challenge-1',
};

describe('createCodeVerifier', () => {
  // RFC 7636 requires 43-128 characters, and base64url means no character needs escaping when it
  // is posted back to the token endpoint.
  it('is long enough for RFC 7636 and needs no escaping', () => {
    const verifier = createCodeVerifier();

    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('mints a different verifier each time', () => {
    expect(createCodeVerifier()).not.toBe(createCodeVerifier());
  });
});

describe('createState', () => {
  it('mints a different state each time', () => {
    expect(createState()).not.toBe(createState());
  });
});

describe('codeChallenge', () => {
  // The worked example from RFC 7636 appendix B. If this drifts, the challenge this browser sends
  // stops matching the verifier it kept, and every sign-in fails at the token endpoint.
  it('matches the S256 example in RFC 7636', async () => {
    await expect(codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).resolves.toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('is stable for the same verifier', async () => {
    const verifier = createCodeVerifier();

    await expect(codeChallenge(verifier)).resolves.toBe(await codeChallenge(verifier));
  });
});

describe('buildAuthorizeUrl', () => {
  it('asks for a code with an S256 challenge', () => {
    const url = new URL(buildAuthorizeUrl(AUTHORIZE, PARAMS));

    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'lugem-cms-admin',
      redirect_uri: 'https://docs.internal/admin/',
      scope: 'openid profile email',
      state: 'state-1',
      code_challenge: 'challenge-1',
      code_challenge_method: 'S256',
    });
  });

  it('keeps a query string the endpoint already carried', () => {
    const url = new URL(buildAuthorizeUrl(`${AUTHORIZE}?tenant=acme`, PARAMS));

    expect(url.searchParams.get('tenant')).toBe('acme');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  // The gateway refuses a token whose `aud` is not its own, so an omitted audience is a sign-in
  // that appears to work and then fails on the first save.
  it('names the audience when one is configured', () => {
    const url = new URL(buildAuthorizeUrl(AUTHORIZE, { ...PARAMS, audience: 'api://lugem-cms' }));

    expect(url.searchParams.get('audience')).toBe('api://lugem-cms');
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
  ])('omits the audience when it is %s', (_case, audience) => {
    const url = new URL(buildAuthorizeUrl(AUTHORIZE, { ...PARAMS, audience }));

    expect(url.searchParams.has('audience')).toBe(false);
  });
});

describe('parseCallback', () => {
  it('reads the code and state', () => {
    expect(parseCallback('?code=abc&state=state-1')).toEqual({
      ok: true,
      code: 'abc',
      state: 'state-1',
    });
  });

  it('reads a query string with no leading question mark', () => {
    expect(parseCallback('code=abc&state=state-1')).toMatchObject({ ok: true, code: 'abc' });
  });

  it('prefers the provider description when it refuses', () => {
    expect(
      parseCallback('?error=access_denied&error_description=Not+in+the+authors+group'),
    ).toEqual({ ok: false, error: 'Not in the authors group' });
  });

  it('falls back to the error code when there is no description', () => {
    expect(parseCallback('?error=access_denied')).toEqual({ ok: false, error: 'access_denied' });
  });

  describe('refuses', () => {
    // A callback with neither a code nor an error must not read as "not signed in yet" — that is
    // how a redirect loop starts.
    const cases: readonly [string, string][] = [
      ['an empty query string', ''],
      ['a code with no state', '?code=abc'],
      ['a state with no code', '?state=state-1'],
    ];

    it.each(cases)('%s', (_case, search) => {
      expect(parseCallback(search)).toMatchObject({ ok: false });
    });
  });
});
