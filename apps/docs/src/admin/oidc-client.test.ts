import { describe, expect, it } from 'vitest';

import { discover, exchangeCode, SignInError } from './oidc-client';

const ISSUER = 'https://idp.example.com/realm';
const TOKEN_ENDPOINT = `${ISSUER}/token`;

const DISCOVERY = {
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: TOKEN_ENDPOINT,
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
  redirectUri: 'https://docs.internal/admin/',
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
      redirect_uri: 'https://docs.internal/admin/',
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
