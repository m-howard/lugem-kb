import { Hono } from 'hono';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTVerifyGetKey,
  SignJWT,
} from 'jose';

/**
 * A stub identity provider, on the same origin as the site — whichever origin that turns out to be.
 *
 * The `/publisher` page signs in with an authorization-code flow, and the browser is what performs it:
 * it fetches discovery, follows a redirect to the authorization endpoint, and posts to the token
 * endpoint. Serving all three from the site's own origin is what keeps that working without CORS —
 * and there is no CORS anywhere in this repository, deliberately, so a cross-origin provider would
 * mean adding a permanent production surface to solve a local problem.
 *
 * Which is why the issuer it publishes is a **path**, not a URL. Local development has more than
 * one front door — the Docusaurus dev server on `:3001`, the sandbox's own port, `localhost` or
 * `127.0.0.1` — and an absolute issuer works from exactly one of them, leaving the others with a
 * discovery fetch the browser refuses. A relative one resolves against whatever page is asking, so
 * every door works and no environment variable has to name the right one.
 *
 * The endpoints below are paths for the same reason, and `discover()` in
 * `apps/docs/src/publisher/oidc-client.ts` is what turns them back into URLs — it resolves them
 * against the document that named them, because one of its callers navigates to the authorization
 * endpoint and a path is not something a browser can be sent to. A real provider publishes absolute
 * URLs, which resolve to themselves.
 *
 * Nothing outside the browser is affected. The `iss` claim carries this same string and the
 * gateway's verifier compares it literally, against a local key set — no discovery, no URL.
 *
 * There is no password box. The thing worth exercising locally is the redirect dance and the code
 * exchange, not a login form nobody here wrote; anyone who reaches `/publisher` is signed in as the
 * configured author.
 *
 * The token is genuinely signed and the gateway genuinely verifies it against this key set. Only
 * discovery is short-circuited — the gateway fetching its own process over HTTP to find a key it
 * already holds would prove nothing.
 */

const KEY_ID = 'sandbox-key-1';
const PUBLISHER_PATH = '/publisher/';
const TOKEN_LIFETIME_SECONDS = 3600;
const MS_PER_SECOND = 1000;
const FOUND = 302;

export interface SandboxAuthor {
  readonly subject: string;
  readonly email: string;
  readonly name: string;
}

export interface SandboxIdpOptions {
  /** Path the provider is mounted at, e.g. `/idp`. Also the issuer, relative to the site. */
  readonly mountPath: string;
  readonly audience: string;
  readonly author: SandboxAuthor;
}

export interface SandboxIdp {
  readonly issuer: string;
  readonly audience: string;
  /** Mount in front of the app. Reached by the browser, so it is real HTTP on the site's origin. */
  readonly routes: Hono;
  /** The local key set the gateway's verifier resolves against. */
  readonly keyResolver: JWTVerifyGetKey;
  /** Mints a token directly, for a script driving the API without a browser. */
  sign(): Promise<string>;
}

/**
 * Builds the sandbox identity provider.
 *
 * @param options - Where it is mounted, who signs in, and the audience the gateway expects.
 * @returns The routes to mount, the key resolver to verify with, and a token minter.
 */
export async function createSandboxIdp(options: SandboxIdpOptions): Promise<SandboxIdp> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: KEY_ID, alg: 'RS256', use: 'sig' } as JWK;
  const issuer = options.mountPath;

  const mint = async (): Promise<string> => {
    const now = Math.floor(Date.now() / MS_PER_SECOND);
    return new SignJWT({
      sub: options.author.subject,
      email: options.author.email,
      name: options.author.name,
    })
      .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
      .setIssuer(issuer)
      .setAudience(options.audience)
      .setIssuedAt(now)
      .setExpirationTime(now + TOKEN_LIFETIME_SECONDS)
      .sign(privateKey);
  };

  const routes = new Hono();

  routes.get('/.well-known/openid-configuration', (c) =>
    c.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
    }),
  );

  routes.get('/jwks', (c) => c.json({ keys: [jwk] }));

  routes.get('/authorize', (c) => {
    // Resolved against this request, so a relative fallback lands on the origin the author is on
    // rather than on whatever address this process happens to be listening at.
    const target = new URL(c.req.query('redirect_uri') ?? PUBLISHER_PATH, c.req.url);
    target.searchParams.set('code', 'sandbox-authorization-code');
    target.searchParams.set('state', c.req.query('state') ?? '');

    return c.redirect(target.toString(), FOUND);
  });

  routes.post('/token', async (c) =>
    c.json({
      access_token: await mint(),
      token_type: 'Bearer',
      expires_in: TOKEN_LIFETIME_SECONDS,
    }),
  );

  return {
    issuer,
    audience: options.audience,
    routes,
    keyResolver: createLocalJWKSet({ keys: [jwk] }),
    sign: mint,
  };
}
