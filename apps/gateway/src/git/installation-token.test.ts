import { decodeJwt, decodeProtectedHeader, generateKeyPair } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';

import { InstallationTokenSource } from './installation-token';
import { requestUrl } from '../../tests/helpers/request-url';

const API = 'https://api.github.test';
const APP_ID = '123456';
const INSTALLATION_ID = '78901234';
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

interface Call {
  readonly url: string;
  readonly appJwt: string;
}

/** A stand-in git host that mints a differently-named token each time, so reuse is observable. */
function fakeGitHost(options: { readonly lifetimeMs?: number; readonly status?: number } = {}) {
  const calls: Call[] = [];
  let minted = 0;
  let now = Date.UTC(2026, 7, 9, 12, 0, 0);

  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    const authorization = String(
      (init?.headers as Record<string, string> | undefined)?.['authorization'],
    );
    calls.push({ url: requestUrl(url), appJwt: authorization.replace(/^Bearer /, '') });

    if (options.status !== undefined) {
      return Promise.resolve(new Response('nope', { status: options.status }));
    }

    minted += 1;
    return Promise.resolve(
      Response.json({
        token: `ghs_token_${String(minted)}`,
        expires_at: new Date(now + (options.lifetimeMs ?? HOUR_MS)).toISOString(),
      }),
    );
  }) as typeof globalThis.fetch;

  return {
    calls,
    fetch: fetchImpl,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function sourceOver(host: ReturnType<typeof fakeGitHost>): Promise<InstallationTokenSource> {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  return new InstallationTokenSource({
    appId: APP_ID,
    installationId: INSTALLATION_ID,
    loadPrivateKey: () => Promise.resolve(privateKey),
    apiBaseUrl: API,
    fetch: host.fetch,
    now: host.now,
  });
}

describe('InstallationTokenSource', () => {
  let host: ReturnType<typeof fakeGitHost>;

  beforeEach(() => {
    host = fakeGitHost();
  });

  it('mints a token for the configured installation', async () => {
    const source = await sourceOver(host);

    expect(await source.token()).toBe('ghs_token_1');
    expect(host.calls[0]?.url).toBe(`${API}/app/installations/${INSTALLATION_ID}/access_tokens`);
  });

  it('authenticates the mint with an app JWT signed by the app key', async () => {
    const source = await sourceOver(host);
    await source.token();

    const jwt = host.calls[0]!.appJwt;
    expect(decodeProtectedHeader(jwt)).toMatchObject({ alg: 'RS256' });

    const claims = decodeJwt(jwt);
    expect(claims.iss).toBe(APP_ID);
    // Backdated, because GitHub rejects an app JWT whose `iat` is in its future.
    expect(claims.iat!).toBeLessThan(Math.floor(host.now() / 1000));
    expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(10 * 60);
  });

  it('reuses a cached token rather than minting per request', async () => {
    const source = await sourceOver(host);

    expect(await source.token()).toBe('ghs_token_1');
    expect(await source.token()).toBe('ghs_token_1');
    expect(host.calls).toHaveLength(1);
  });

  // R2: "Installation tokens are minted on demand and cached, refreshing at least 5 minutes
  // before expiry." A token that is still technically valid but nearly spent is refreshed, so a
  // request cannot start valid and finish expired.
  it('refreshes more than five minutes before expiry', async () => {
    const source = await sourceOver(host);
    await source.token();

    host.advance(HOUR_MS - 6 * MINUTE_MS);
    expect(await source.token()).toBe('ghs_token_1');

    host.advance(2 * MINUTE_MS);
    expect(await source.token()).toBe('ghs_token_2');
  });

  // R2: "Concurrent requests during refresh mint exactly one token."
  it('mints exactly one token for concurrent callers', async () => {
    const source = await sourceOver(host);

    const tokens = await Promise.all([source.token(), source.token(), source.token()]);

    expect(tokens).toEqual(['ghs_token_1', 'ghs_token_1', 'ghs_token_1']);
    expect(host.calls).toHaveLength(1);
  });

  it('mints again after invalidation, which is how a 401 recovers', async () => {
    const source = await sourceOver(host);
    expect(await source.token()).toBe('ghs_token_1');

    source.invalidate();

    expect(await source.token()).toBe('ghs_token_2');
    expect(host.calls).toHaveLength(2);
  });

  it('does not wedge on a failed mint', async () => {
    const failing = fakeGitHost({ status: 401 });
    const source = await sourceOver(failing);

    await expect(source.token()).rejects.toThrow('401');
    await expect(source.token()).rejects.toThrow('401');
    expect(failing.calls).toHaveLength(2);
  });

  it('surfaces a refusal with something an operator can act on', async () => {
    const source = await sourceOver(fakeGitHost({ status: 404 }));

    await expect(source.token()).rejects.toThrow(/app id/);
  });

  describe('checkCredential', () => {
    it('resolves when a token can be minted, which is what /readyz asks', async () => {
      const source = await sourceOver(host);

      await expect(source.checkCredential()).resolves.toBe(true);
    });

    // R10: readiness fails until a token can be minted, so a miscredentialed task never joins the
    // target group. Until the PEM is written the secret is empty and this is the failure operators
    // see — docs/corpus-repository.md promises exactly that.
    it('rejects when the credential is not usable', async () => {
      const source = await sourceOver(fakeGitHost({ status: 401 }));

      await expect(source.checkCredential()).rejects.toThrow();
    });
  });
});
