import { describe, expect, it } from 'vitest';

import { type AccessToken } from './oidc-client';
import { authorizingFetch, createPublisherSession, isExpired } from './session';

const PROXY_PATH = '/v1/cms/proxy';

/** A `Storage` backed by a Map, which is all the session store actually uses. */
function memoryStorage(seed: Record<string, string> = {}): Storage {
  const entries = new Map(Object.entries(seed));

  return {
    get length() {
      return entries.size;
    },
    clear: () => {
      entries.clear();
    },
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => {
      entries.delete(key);
    },
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  };
}

const LIVE_TOKEN: AccessToken = { token: 'access-1', expiresAt: 2_000 };

describe('isExpired', () => {
  it.each([
    ['before expiry', 1_999, false],
    ['exactly at expiry', 2_000, true],
    ['after expiry', 2_001, true],
  ])('%s', (_case, now, expected) => {
    expect(isExpired(LIVE_TOKEN, now)).toBe(expected);
  });
});

describe('createPublisherSession', () => {
  it('round-trips a token', () => {
    const session = createPublisherSession(memoryStorage(), () => 0);
    session.writeToken(LIVE_TOKEN);

    expect(session.readToken()).toEqual(LIVE_TOKEN);
  });

  it('answers with no token before anyone has signed in', () => {
    expect(createPublisherSession(memoryStorage(), () => 0).readToken()).toBeUndefined();
  });

  it('discards an expired token rather than handing it to the editor', () => {
    const storage = memoryStorage();
    const session = createPublisherSession(storage, () => 5_000);
    session.writeToken(LIVE_TOKEN);

    expect(session.readToken()).toBeUndefined();
    expect(storage.getItem('lugem-cms.token')).toBeNull();
  });

  // Unreadable storage must mean "sign in again", not a blank editor with a console error.
  it.each([
    ['unparseable', '{not json'],
    ['the wrong shape', '{"nope":1}'],
  ])('treats %s storage as signed out', (_case, raw) => {
    const session = createPublisherSession(memoryStorage({ 'lugem-cms.token': raw }), () => 0);

    expect(session.readToken()).toBeUndefined();
  });

  it('round-trips an in-flight sign-in', () => {
    const session = createPublisherSession(memoryStorage(), () => 0);
    session.startFlight({ verifier: 'v', state: 's' });

    expect(session.readFlight()).toEqual({ verifier: 'v', state: 's' });
  });

  // Once a token exists the verifier has done its job. Leaving it behind would let a replayed
  // callback be matched a second time.
  it('forgets the in-flight sign-in once a token arrives', () => {
    const session = createPublisherSession(memoryStorage(), () => 0);
    session.startFlight({ verifier: 'v', state: 's' });
    session.writeToken(LIVE_TOKEN);

    expect(session.readFlight()).toBeUndefined();
  });

  it('clears both on sign-out', () => {
    const session = createPublisherSession(memoryStorage(), () => 0);
    session.startFlight({ verifier: 'v', state: 's' });
    session.writeToken(LIVE_TOKEN);

    session.clear();

    expect(session.readToken()).toBeUndefined();
    expect(session.readFlight()).toBeUndefined();
  });
});

describe('authorizingFetch', () => {
  const ORIGIN = 'https://docs.internal';

  function recordingFetch(): { calls: RequestInit[]; fetch: typeof globalThis.fetch } {
    const calls: RequestInit[] = [];
    return {
      calls,
      fetch: (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(init ?? {});
        return Promise.resolve(new Response('{}'));
      },
    };
  }

  function authorization(init: RequestInit | undefined): string | null {
    return new Headers(init?.headers ?? {}).get('authorization');
  }

  it('attaches the token to the adapter endpoint', async () => {
    const inner = recordingFetch();
    const wrapped = authorizingFetch({
      fetch: inner.fetch,
      token: () => 'access-1',
      path: PROXY_PATH,
      origin: ORIGIN,
    });

    await wrapped(PROXY_PATH, { method: 'POST' });

    expect(authorization(inner.calls[0])).toBe('Bearer access-1');
  });

  it('keeps the headers the caller already set', async () => {
    const inner = recordingFetch();
    const wrapped = authorizingFetch({
      fetch: inner.fetch,
      token: () => 'access-1',
      path: PROXY_PATH,
      origin: ORIGIN,
    });

    await wrapped(PROXY_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });

    expect(new Headers(inner.calls[0]?.headers).get('content-type')).toBe(
      'application/json; charset=utf-8',
    );
  });

  // The token is for the gateway and nothing else. Every row here is a request that must not
  // carry it.
  describe('does not attach the token to', () => {
    const cases: readonly [string, string][] = [
      ['another path on this origin', '/v1/ask'],
      ['a path that merely starts the same', '/v1/cms/proxy-other'],
      ['a parent path', '/v1/cms'],
      ['another origin', 'https://evil.example.com/v1/cms/proxy'],
    ];

    it.each(cases)('%s', async (_case, target) => {
      const inner = recordingFetch();
      const wrapped = authorizingFetch({
        fetch: inner.fetch,
        token: () => 'access-1',
        path: PROXY_PATH,
        origin: ORIGIN,
      });

      await wrapped(target, { method: 'POST' });

      expect(authorization(inner.calls[0])).toBeNull();
    });
  });

  // Fails closed when it cannot tell which origin it is on. Not attaching the token costs one
  // 401; attaching it to the wrong host costs the credential.
  it('attaches nothing when the origin is unknown', async () => {
    const inner = recordingFetch();
    const wrapped = authorizingFetch({
      fetch: inner.fetch,
      token: () => 'access-1',
      path: PROXY_PATH,
      origin: undefined,
    });

    await wrapped(PROXY_PATH, { method: 'POST' });

    expect(authorization(inner.calls[0])).toBeNull();
  });

  it('passes the request straight through when nobody is signed in', async () => {
    const inner = recordingFetch();
    const wrapped = authorizingFetch({
      fetch: inner.fetch,
      token: () => undefined,
      path: PROXY_PATH,
      origin: ORIGIN,
    });

    await wrapped(PROXY_PATH, { method: 'POST' });

    expect(authorization(inner.calls[0])).toBeNull();
  });

  it('ignores a target it cannot parse as a URL', async () => {
    const inner = recordingFetch();
    const wrapped = authorizingFetch({
      fetch: inner.fetch,
      token: () => 'access-1',
      path: PROXY_PATH,
      origin: ORIGIN,
    });

    await wrapped('http://[', { method: 'POST' });

    expect(authorization(inner.calls[0])).toBeNull();
  });
});
