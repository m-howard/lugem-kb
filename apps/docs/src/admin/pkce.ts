/**
 * The authorization-code-with-PKCE pieces the `/admin` page needs, as pure functions.
 *
 * Decap's `proxy` backend sends no `Authorization` header and its `getToken` returns an empty
 * string, so the admin page obtains its own token and attaches it. PKCE rather than an implicit
 * flow because the page is a public client with no secret to hold: the verifier never leaves the
 * browser, and an intercepted authorization code is useless without it.
 *
 * Everything here is pure so it can be tested under vitest's node environment — `crypto.subtle`
 * and `crypto.getRandomValues` are the same API in both places. The redirecting and the token
 * exchange live in `session.ts`, which is the part Playwright covers.
 */

/** 32 bytes, comfortably inside RFC 7636's 43–128 character range once base64url-encoded. */
const VERIFIER_BYTES = 32;
const STATE_BYTES = 16;

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomBase64Url(length: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(length)));
}

/**
 * Mints a code verifier.
 *
 * @returns A fresh high-entropy verifier, base64url-encoded.
 */
export function createCodeVerifier(): string {
  return randomBase64Url(VERIFIER_BYTES);
}

/**
 * Mints a state value, which is what ties a callback to the sign-in that started it.
 *
 * @returns A fresh random state.
 */
export function createState(): string {
  return randomBase64Url(STATE_BYTES);
}

/**
 * Derives the S256 challenge for a verifier.
 *
 * @param verifier - The code verifier held by this browser.
 * @returns The base64url-encoded SHA-256 of the verifier.
 *
 * @example
 * ```ts
 * const challenge = await codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
 * // → 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
 * ```
 */
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export interface AuthorizeParams {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: string;
  readonly state: string;
  readonly challenge: string;
  /**
   * The API the token must be issued for.
   *
   * Several providers issue an opaque userinfo token unless an audience is named, and the gateway
   * refuses a token whose `aud` does not match `AUTH_AUDIENCE` — which would look to an author
   * like a broken CMS rather than a missing request parameter.
   */
  readonly audience?: string | undefined;
}

/**
 * Builds the URL that starts a sign-in.
 *
 * @param endpoint - The provider's authorization endpoint, from its discovery document.
 * @param params - Client id, redirect, scopes, state, challenge and optional audience.
 * @returns The URL to send the browser to.
 */
export function buildAuthorizeUrl(endpoint: string, params: AuthorizeParams): string {
  const url = new URL(endpoint);

  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', params.scopes);
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (params.audience !== undefined && params.audience !== '') {
    url.searchParams.set('audience', params.audience);
  }

  return url.toString();
}

export type CallbackResult =
  | { readonly ok: true; readonly code: string; readonly state: string }
  | { readonly ok: false; readonly error: string };

/**
 * Reads the provider's answer out of a callback query string.
 *
 * A callback carrying neither a code nor an error is reported as a failure rather than ignored:
 * silently treating it as "not signed in yet" is how a redirect loop starts.
 *
 * @param search - The callback URL's query string, with or without its leading `?`.
 * @returns The authorization code and state, or the reason there is none.
 */
export function parseCallback(search: string): CallbackResult {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);

  const error = params.get('error');
  if (error !== null) {
    return { ok: false, error: params.get('error_description') ?? error };
  }

  const code = params.get('code');
  const state = params.get('state');
  if (code === null || state === null) {
    return { ok: false, error: 'The identity provider returned no authorization code.' };
  }

  return { ok: true, code, state };
}
