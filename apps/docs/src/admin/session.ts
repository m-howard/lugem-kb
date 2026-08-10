import { type AccessToken } from './oidc-client';

/** Where the token lives between the callback and the editor loading. */
const TOKEN_KEY = 'lugem-cms.token';
/** The in-flight sign-in: the verifier and state a callback has to be matched against. */
const FLIGHT_KEY = 'lugem-cms.sign-in';

export interface SignInFlight {
  readonly verifier: string;
  readonly state: string;
}

/**
 * Reads a stored value, tolerating a storage that has been cleared or corrupted.
 *
 * Anything unreadable is treated as absent, which makes the failure "sign in again" rather than a
 * blank editor with a parse error in the console.
 */
function readJson(storage: Storage, key: string): Record<string, unknown> | undefined {
  const raw = storage.getItem(key);
  if (raw === null) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    storage.removeItem(key);
    return undefined;
  }
}

function readText(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Whether a token is spent.
 *
 * @param token - The stored token.
 * @param now - Epoch milliseconds, injected so the boundary is testable.
 * @returns Whether it should be discarded.
 */
export function isExpired(token: AccessToken, now: number = Date.now()): boolean {
  return token.expiresAt <= now;
}

/**
 * The browser's memory of who is signed in.
 *
 * `sessionStorage` rather than `localStorage`, deliberately: the token dies with the tab. The
 * corpus holds HR and finance content, so an access token left in a shared browser profile is a
 * longer-lived credential than anyone intended (requirements.md Q11 takes the same line about
 * query logs).
 */
export interface AdminSession {
  readToken(): AccessToken | undefined;
  writeToken(token: AccessToken): void;
  readFlight(): SignInFlight | undefined;
  startFlight(flight: SignInFlight): void;
  clear(): void;
}

/**
 * Builds the session store over a browser storage.
 *
 * @param storage - Usually `window.sessionStorage`; injected so this is testable in node.
 * @param now - Epoch milliseconds, injected so expiry is testable.
 * @returns The store.
 */
export function createAdminSession(storage: Storage, now: () => number = Date.now): AdminSession {
  return {
    readToken() {
      const stored = readJson(storage, TOKEN_KEY);
      const value = stored === undefined ? undefined : readText(stored, 'token');
      if (stored === undefined || value === undefined) {
        return undefined;
      }

      const expiresAt = typeof stored.expiresAt === 'number' ? stored.expiresAt : 0;
      const token: AccessToken = { token: value, expiresAt };
      if (isExpired(token, now())) {
        storage.removeItem(TOKEN_KEY);
        return undefined;
      }

      return token;
    },
    writeToken(token) {
      storage.setItem(TOKEN_KEY, JSON.stringify(token));
      // The sign-in that produced this token is finished; leaving its verifier behind would let a
      // replayed callback be matched a second time.
      storage.removeItem(FLIGHT_KEY);
    },
    readFlight() {
      const stored = readJson(storage, FLIGHT_KEY);
      if (stored === undefined) {
        return undefined;
      }

      const verifier = readText(stored, 'verifier');
      const state = readText(stored, 'state');
      return verifier === undefined || state === undefined ? undefined : { verifier, state };
    },
    startFlight(flight) {
      storage.setItem(FLIGHT_KEY, JSON.stringify(flight));
    },
    clear() {
      storage.removeItem(TOKEN_KEY);
      storage.removeItem(FLIGHT_KEY);
    },
  };
}

export interface AuthorizingFetchOptions {
  readonly fetch: typeof globalThis.fetch;
  readonly token: () => string | undefined;
  /** Only requests to this path receive the token. */
  readonly path: string;
  /**
   * The origin the token may be sent to — the page's own, supplied by the caller.
   *
   * Required rather than read from `location` here, on purpose. Reading an ambient global inside
   * the check meant that anywhere `location` was undefined the comparison silently passed, and
   * "the security check is skipped when a global is missing" is the shape of bug that only shows
   * up somewhere it matters. `undefined` is still accepted, and refuses everything.
   */
  readonly origin: string | undefined;
}

/**
 * Wraps `fetch` so the adapter endpoint — and only it — carries the author's token.
 *
 * This exists because Decap's proxy backend has no way to send a header: its `getToken` returns an
 * empty string and its request builder sets `content-type` and nothing else. Wrapping `fetch` is
 * the smallest place to add one.
 *
 * The path is matched exactly rather than by prefix, so a token cannot be attached to an
 * unrelated request that happens to start with the same characters — and never to a cross-origin
 * one, which is the failure that would actually leak the credential.
 *
 * @param options - The underlying fetch, a token source, and the path to authorise.
 * @returns A fetch to install in place of the global one.
 */
export function authorizingFetch(options: AuthorizingFetchOptions): typeof globalThis.fetch {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const token = options.token();
    if (token === undefined || !targets(input, options.origin, options.path)) {
      return options.fetch(input, init);
    }

    const headers = new Headers(init?.headers ?? {});
    headers.set('authorization', `Bearer ${token}`);

    return options.fetch(input, { ...init, headers });
  };
}

/**
 * Whether a request targets exactly `path` on `origin`.
 *
 * Fails closed on anything it cannot resolve, including an unknown origin: not attaching the token
 * costs an author one 401, while attaching it to the wrong host costs them the credential.
 */
function targets(input: RequestInfo | URL, origin: string | undefined, path: string): boolean {
  if (origin === undefined) {
    return false;
  }

  try {
    const url = new URL(requestHref(input), origin);
    return url.origin === origin && url.pathname === path;
  } catch {
    return false;
  }
}

/** The URL a `fetch` argument names, in any of the three shapes it can take. */
function requestHref(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}
