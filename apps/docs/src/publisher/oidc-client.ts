/** Where a provider's discovery document lives, relative to its issuer. */
const DISCOVERY_PATH = '/.well-known/openid-configuration';

const SECONDS_PER_MS = 1000;
/** Treat a token as spent slightly early, so a save cannot start with seconds left on it. */
const EXPIRY_SKEW_SECONDS = 30;

export interface ProviderEndpoints {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
}

export interface AccessToken {
  readonly token: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
}

export class SignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignInError';
  }
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Reads the provider's endpoints from its discovery document.
 *
 * The endpoints are discovered rather than configured for the same reason `bearer-verifier.ts`
 * discovers the key set: the gateway is given an issuer, and everything else about a provider is
 * the provider's to state. Two settings that must agree are one setting too many.
 *
 * What comes back is resolved against the document that named it, so a provider may publish its
 * endpoints as paths. The local sandbox does exactly that — one document then works from every port
 * a developer might have the site open on — and a real provider publishes absolute URLs, which
 * resolve to themselves. The callers cannot tell the difference, and one of them must not have to:
 * `buildAuthorizeUrl` navigates to the authorization endpoint and needs something navigable.
 *
 * @param issuer - The OIDC issuer URL. Absolute; `main.ts` resolves a configured path first.
 * @param fetchImpl - Injected so this is testable without a network.
 * @returns The authorization and token endpoints, absolute.
 * @throws {SignInError} When the document cannot be read or names neither endpoint.
 */
export async function discover(
  issuer: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<ProviderEndpoints> {
  const url = `${issuer.replace(/\/+$/, '')}${DISCOVERY_PATH}`;
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new SignInError(`The identity provider's configuration could not be read from ${url}.`);
  }

  const document = (await response.json()) as Record<string, unknown>;
  const authorizationEndpoint = readString(document, 'authorization_endpoint');
  const tokenEndpoint = readString(document, 'token_endpoint');
  if (authorizationEndpoint === undefined || tokenEndpoint === undefined) {
    throw new SignInError(
      `The identity provider at ${issuer} published an incomplete configuration.`,
    );
  }

  return {
    authorizationEndpoint: new URL(authorizationEndpoint, url).href,
    tokenEndpoint: new URL(tokenEndpoint, url).href,
  };
}

export interface CodeExchange {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly code: string;
  readonly verifier: string;
  readonly redirectUri: string;
}

/**
 * Trades an authorization code for an access token.
 *
 * No client secret, because the publisher page is a public client: the code verifier is what proves
 * this is the same browser that started the sign-in.
 *
 * @param exchange - The token endpoint, client id, code, verifier and redirect.
 * @param fetchImpl - Injected so this is testable without a network.
 * @returns The access token and when it expires.
 * @throws {SignInError} When the provider refuses, or returns no access token.
 */
export async function exchangeCode(
  exchange: CodeExchange,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<AccessToken> {
  const response = await fetchImpl(exchange.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: exchange.clientId,
      code: exchange.code,
      code_verifier: exchange.verifier,
      redirect_uri: exchange.redirectUri,
    }).toString(),
  });

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new SignInError(
      readString(body, 'error_description') ??
        readString(body, 'error') ??
        'The identity provider refused the sign-in.',
    );
  }

  const token = readString(body, 'access_token');
  if (token === undefined) {
    throw new SignInError('The identity provider returned no access token.');
  }

  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 0;
  return {
    token,
    expiresAt: Date.now() + Math.max(0, expiresIn - EXPIRY_SKEW_SECONDS) * SECONDS_PER_MS,
  };
}
