import { describe, expect, it } from 'vitest';

import { discover, exchangeCode, SignInError } from './oidc-client';
import { buildAuthorizeUrl } from './pkce';

const ISSUER = 'https://idp.example.com/realm';
const TOKEN_ENDPOINT = `${ISSUER}/token`;

const DISCOVERY = {
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: TOKEN_ENDPOINT,
};

/** The shape the local sandbox publishes: same document, endpoints as paths. */
const RELATIVE_DISCOVERY = {
  authorization_endpoint: '/idp/authorize',
  token_endpoint: '/idp/token',
};

interface FakeCall {
  readonly url: string;
  readonly body: string;
}

function href(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function fakeFetch(respond: (url: string) => Response): {
  calls: FakeCall[];
  fetch: typeof globalThis.fetch;
} {
  const calls: FakeCall[] = [];
  return {
    calls,
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const url = href(input);
      calls.push({ url, body: typeof init?.body === 'string' ? init.body : '' });
      return Promise.resolve(respond(url));
    },
  };
}

const EXCHANGE = {
  tokenEndpoint: TOKEN_ENDPOINT,
  clientId: 'lugem-cms-admin',
  code: 'auth-code',
  verifier: 'verifier-1',
  redirectUri: 'https://docs.internal/publisher/',
};

describe('discover', () => {
  it('reads the endpoints from the well-known document', async () => {
    const host = fakeFetch(() => Response.json(DISCOVERY));

    await expect(discover(ISSUER, host.fetch)).resolves.toEqual({
      authorizationEndpoint: `${ISSUER}/authorize`,
      tokenEndpoint: TOKEN_ENDPOINT,
    });
    expect(host.calls[0]?.url).toBe(`${ISSUER}/.well-known/openid-configuration`);
  });

  it('does not double the slash on an issuer with a trailing one', async () => {
    const host = fakeFetch(() => Response.json(DISCOVERY));
    await discover(`${ISSUER}/`, host.fetch);

    expect(host.calls[0]?.url).toBe(`${ISSUER}/.well-known/openid-configuration`);
  });

  it('names the URL it could not read', async () => {
    const host = fakeFetch(() => new Response('nope', { status: 404 }));

    await expect(discover(ISSUER, host.fetch)).rejects.toThrow(/openid-configuration/);
  });

  it.each([
    ['no token endpoint', { authorization_endpoint: `${ISSUER}/authorize` }],
    ['no authorization endpoint', { token_endpoint: TOKEN_ENDPOINT }],
    ['a blank endpoint', { ...DISCOVERY, token_endpoint: '' }],
  ])('refuses a document with %s', async (_case, document) => {
    const host = fakeFetch(() => Response.json(document));

    await expect(discover(ISSUER, host.fetch)).rejects.toThrow(SignInError);
  });

  // The local sandbox publishes paths so that one document works from every port the site might be
  // open on. A path is fine for the `fetch` calls either side of this and useless to the one caller
  // that navigates, so this is where it stops being a path.
  it('resolves endpoints published as paths against the document that named them', async () => {
    const host = fakeFetch(() => Response.json(RELATIVE_DISCOVERY));

    await expect(discover(ISSUER, host.fetch)).resolves.toEqual({
      authorizationEndpoint: 'https://idp.example.com/idp/authorize',
      tokenEndpoint: 'https://idp.example.com/idp/token',
    });
  });
});

/**
 * The seam, driven end to end: what `discover` returns is what starts a sign-in.
 *
 * Both halves passed on their own while this was broken. `discover` is relative-safe — its own
 * `fetch` resolves a path — and every `buildAuthorizeUrl` test passed an absolute endpoint, so
 * nothing asserted that the first function returns what the second one requires. A browser said
 * `Failed to construct 'URL': Invalid URL` instead.
 */
describe('discover into buildAuthorizeUrl', () => {
  it('produces a URL the browser can be sent to, from a document of paths', async () => {
    const host = fakeFetch(() => Response.json(RELATIVE_DISCOVERY));

    const { authorizationEndpoint } = await discover(ISSUER, host.fetch);
    const authorizeUrl = buildAuthorizeUrl(authorizationEndpoint, {
      clientId: 'lugem-cms-admin',
      redirectUri: 'https://docs.internal/publisher/',
      scopes: 'openid profile email',
      state: 'state-1',
      challenge: 'challenge-1',
    });

    expect(new URL(authorizeUrl).pathname).toBe('/idp/authorize');
    expect(new URL(authorizeUrl).searchParams.get('response_type')).toBe('code');
  });
});

describe('exchangeCode', () => {
  it('posts the code and verifier as a form, with no client secret', async () => {
    const host = fakeFetch(() => Response.json({ access_token: 'access-1', expires_in: 3600 }));
    await exchangeCode(EXCHANGE, host.fetch);

    const body = new URLSearchParams(host.calls[0]?.body ?? '');
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'authorization_code',
      client_id: 'lugem-cms-admin',
      code: 'auth-code',
      code_verifier: 'verifier-1',
      redirect_uri: 'https://docs.internal/publisher/',
    });
    expect(body.has('client_secret')).toBe(false);
  });

  // The skew is what stops a save starting with seconds left on the token and failing mid-write.
  it('expires the token early by the configured skew', async () => {
    const host = fakeFetch(() => Response.json({ access_token: 'access-1', expires_in: 3600 }));
    const before = Date.now();

    const token = await exchangeCode(EXCHANGE, host.fetch);

    expect(token.token).toBe('access-1');
    expect(token.expiresAt).toBeGreaterThanOrEqual(before + (3600 - 30) * 1000);
    expect(token.expiresAt).toBeLessThan(before + 3600 * 1000);
  });

  it('treats a response with no expiry as already spent', async () => {
    const host = fakeFetch(() => Response.json({ access_token: 'access-1' }));

    const token = await exchangeCode(EXCHANGE, host.fetch);

    expect(token.expiresAt).toBeLessThanOrEqual(Date.now());
  });

  it('surfaces the provider description when it refuses', async () => {
    const host = fakeFetch(() =>
      Response.json(
        { error: 'invalid_grant', error_description: 'Code already used' },
        { status: 400 },
      ),
    );

    await expect(exchangeCode(EXCHANGE, host.fetch)).rejects.toThrow('Code already used');
  });

  it('falls back to the error code', async () => {
    const host = fakeFetch(() => Response.json({ error: 'invalid_grant' }, { status: 400 }));

    await expect(exchangeCode(EXCHANGE, host.fetch)).rejects.toThrow('invalid_grant');
  });

  it('survives a refusal whose body is not JSON', async () => {
    const host = fakeFetch(() => new Response('<html>gateway error</html>', { status: 502 }));

    await expect(exchangeCode(EXCHANGE, host.fetch)).rejects.toThrow(SignInError);
  });

  it('refuses a success that carries no access token', async () => {
    const host = fakeFetch(() => Response.json({ id_token: 'only-an-id-token' }));

    await expect(exchangeCode(EXCHANGE, host.fetch)).rejects.toThrow(/no access token/);
  });
});
