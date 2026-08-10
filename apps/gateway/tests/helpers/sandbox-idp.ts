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
 * A stub identity provider, on the same origin as the site.
 *
 * The `/admin` page signs in with an authorization-code flow, and the browser is what performs it:
 * it fetches discovery, follows a redirect to the authorization endpoint, and posts to the token
 * endpoint. Serving all three from the site's own origin is what keeps that working without CORS —
 * and there is no CORS anywhere in this repository, deliberately, so a cross-origin provider would
 * mean adding a permanent production surface to solve a local problem.
 *
 * There is no password box. The thing worth exercising locally is the redirect dance and the code
 * exchange, not a login form nobody here wrote; anyone who reaches `/admin` is signed in as the
 * configured author.
 *
 * The token is genuinely signed and the gateway genuinely verifies it against this key set. Only
 * discovery is short-circuited — the gateway fetching its own process over HTTP to find a key it
 * already holds would prove nothing.
 */

const KEY_ID = 'sandbox-key-1';
const TOKEN_LIFETIME_SECONDS = 3600;
const MS_PER_SECOND = 1000;
const FOUND = 302;

export interface SandboxAuthor {
  readonly subject: string;
  readonly email: string;
  readonly name: string;
}

export interface SandboxIdpOptions {
  /** Where this server is reachable, e.g. `http://127.0.0.1:4300`. */
  readonly origin: string;
  /** Path the provider is mounted at, e.g. `/idp`. */
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
  const issuer = `${options.origin}${options.mountPath}`;

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
    const target = new URL(c.req.query('redirect_uri') ?? `${options.origin}/admin/`);
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
