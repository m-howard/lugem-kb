import CMS from 'decap-cms-app';

import { classifyConfigResponse, type ConfigOutcome } from './config-response';
import { discover, exchangeCode, SignInError } from './oidc-client';
import {
  buildAuthorizeUrl,
  codeChallenge,
  createCodeVerifier,
  createState,
  parseCallback,
} from './pkce';
import { PREVIEW_STYLE } from './preview-style';
import { type PublisherSession, authorizingFetch, createPublisherSession } from './session';

/**
 * The `/publisher` page: sign in, then hand a configured Decap CMS an authorised `fetch`.
 *
 * The thin layer. Everything with a decision in it — deriving a challenge, matching a callback,
 * deciding which requests may carry the token — lives in `pkce.ts` and `session.ts`, where it is
 * unit-tested. What is left here is redirects and DOM, which Playwright covers end to end.
 */

const PUBLISHER_PATH = '/publisher/';
const PROXY_PATH = '/v1/cms/proxy';
const PUBLISHER_CONFIG_PATH = '/v1/publisher/config';
const CMS_CONFIG_PATH = '/v1/cms/config';
const IDENTITY_PATH = '/v1/cms/identity';
const UNAUTHORIZED = 401;

/**
 * What to say when the sign-in configuration never arrives — one message per way of not arriving.
 *
 * Each names the thing the reader can act on. `not-the-gateway` is the one a developer reaches by
 * running the site without a gateway behind it — `docusaurus start` proxies the API to one, but
 * only if there is one to proxy to — so it names the command that starts both.
 */
const CONFIG_FAILURE_MESSAGE: Record<Exclude<ConfigOutcome, 'configured'>, string> = {
  // No backticks or markdown: this is written with `textContent`, so it renders as typed.
  'not-the-gateway':
    'The documentation gateway is not answering at this address, so there is no editor to sign ' +
    'in to. If you are running the site locally, start the gateway with it: bun run dev:all. ' +
    'Otherwise, ask a platform engineer.',
  unconfigured: 'The authoring CMS is not configured on this deployment.',
  unreachable: 'The documentation gateway could not say how to sign you in. Try again shortly.',
};

interface PublisherConfig {
  readonly authMode: 'bearer' | 'alb';
  readonly issuer?: string;
  readonly clientId?: string;
  readonly audience?: string;
  readonly scopes?: string;
  readonly signInPath?: string;
}

interface GatewayCmsConfig {
  readonly repository: string;
  readonly defaultBranch: string;
  /** Repository folder uploads are written to, e.g. `docs/assets/media/` — requirements.md R15. */
  readonly mediaFolder: string;
  /** Site path they are served from, e.g. `/media`. Derived by the gateway, not chosen here. */
  readonly publicFolder: string;
  readonly maxUploadBytes: number;
}

const BYTES_PER_MB = 1_000_000;

/**
 * Whether this message is a wait or a dead end.
 *
 * The distinction is the author's, not the code's: a sign-in still in flight resolves itself and a
 * failed one never will, and as plain text the two are indistinguishable. `static/publisher/index.html`
 * styles them apart off this attribute.
 */
type SignInState = 'pending' | 'failed';

/**
 * Writes the one message this page has, and says which kind it is.
 *
 * @param message - What to show. Empty clears it, which is what handing over to Decap looks like.
 * @param state - Defaults to `pending`; every caller that has bad news passes `failed`.
 */
function status(message: string, state: SignInState = 'pending'): void {
  const target = document.querySelector<HTMLElement>('#sign-in-status');
  if (target !== null) {
    target.textContent = message;
    target.dataset.state = state;
  }
}

/**
 * Decap's own configuration type, derived from `init` rather than imported.
 *
 * `decap-cms-app` re-exports only the `CMS` interface, so this is how the shape is named without
 * reaching into `decap-cms-core`'s internals — and it means a Decap upgrade that changes the
 * config fails this build rather than the editor.
 */
type DecapConfig = NonNullable<NonNullable<Parameters<typeof CMS.init>[0]>['config']>;

/** The upload limit as a person would say it, for the hint beside the editor. */
function uploadLimit(cms: GatewayCmsConfig): string {
  return `${(cms.maxUploadBytes / BYTES_PER_MB).toFixed(1)} MB`;
}

/** The Decap configuration, built once the gateway has said what repository it serves. */
function decapConfig(cms: GatewayCmsConfig): DecapConfig {
  return {
    backend: { name: 'proxy', proxy_url: PROXY_PATH, branch: cms.defaultBranch },
    // Not a choice. Decap's simple mode commits straight to the configured branch, which branch
    // policy refuses as `default-branch` — editorial workflow is the only mode that can work here.
    publish_mode: 'editorial_workflow',
    // requirements.md R15. Both come from the gateway rather than being written here: it is the
    // gateway that confines uploads to a folder and refuses one outside it, so a second copy of the
    // answer in the browser would only ever be a chance to disagree. See ADR 0021.
    media_folder: cms.mediaFolder,
    public_folder: cms.publicFolder,
    site_url: globalThis.location.origin,
    display_url: globalThis.location.origin,
    collections: [
      {
        name: 'docs',
        label: 'Documentation',
        folder: 'docs',
        extension: 'md',
        format: 'frontmatter',
        create: true,
        slug: '{{slug}}',
        nested: { depth: 4 },
        meta: { path: { widget: 'string', label: 'Path', index_file: 'index' } },
        fields: [
          { name: 'title', label: 'Title', widget: 'string' },
          { name: 'owner', label: 'Owning team', widget: 'string' },
          {
            name: 'last_reviewed',
            label: 'Last reviewed',
            widget: 'datetime',
            format: 'YYYY-MM-DD',
            date_format: 'YYYY-MM-DD',
            time_format: false,
          },
          { name: 'sidebar_label', label: 'Sidebar label', widget: 'string', required: false },
          {
            name: 'sidebar_position',
            label: 'Sidebar position',
            widget: 'number',
            required: false,
            value_type: 'int',
          },
          {
            name: 'body',
            label: 'Page',
            widget: 'markdown',
            // Decap has no client-side size limit for its own media library, so an oversized image
            // is refused by the gateway when the entry is saved rather than when it is picked. The
            // hint is what stops that being a surprise — R15 asks for a clear message, and the
            // clearest one arrives before the upload rather than after it.
            hint: `Images are welcome — up to ${uploadLimit(cms)} each, as PNG, JPEG, GIF or WebP. They are published with the page.`,
          },
        ],
      },
    ],
  };
}

/**
 * The issuer as a URL this browser can fetch: a configured path resolves against this page.
 *
 * Which is the point of allowing a path at all. The sandbox publishes `/idp` rather than an origin
 * because local development has several front doors — `:3001`, the gateway's own port, `localhost`
 * or `127.0.0.1` — and an issuer naming one of them is cross-origin from the rest. A real provider
 * is absolute and resolves to itself.
 */
function issuerUrl(config: PublisherConfig): string {
  return new URL(config.issuer ?? '', globalThis.location.origin).href;
}

/** Starts an authorization-code flow, remembering the verifier this browser will need back. */
async function beginSignIn(config: PublisherConfig, session: PublisherSession): Promise<void> {
  const { authorizationEndpoint } = await discover(issuerUrl(config));
  const verifier = createCodeVerifier();
  const state = createState();

  session.startFlight({ verifier, state });
  globalThis.location.assign(
    buildAuthorizeUrl(authorizationEndpoint, {
      clientId: config.clientId ?? '',
      redirectUri: `${globalThis.location.origin}${PUBLISHER_PATH}`,
      scopes: config.scopes ?? 'openid profile email',
      state,
      challenge: await codeChallenge(verifier),
      audience: config.audience,
    }),
  );
}

/**
 * Completes a sign-in the provider has just redirected back from.
 *
 * The state is compared against the one this browser stored, which is what stops a callback from
 * somewhere else being accepted as this session's.
 */
async function completeSignIn(config: PublisherConfig, session: PublisherSession): Promise<void> {
  const callback = parseCallback(globalThis.location.search);
  if (!callback.ok) {
    throw new SignInError(callback.error);
  }

  const flight = session.readFlight();
  if (flight?.state !== callback.state) {
    throw new SignInError('This sign-in did not start in this browser. Try again.');
  }

  const { tokenEndpoint } = await discover(issuerUrl(config));
  session.writeToken(
    await exchangeCode({
      tokenEndpoint,
      clientId: config.clientId ?? '',
      code: callback.code,
      verifier: flight.verifier,
      redirectUri: `${globalThis.location.origin}${PUBLISHER_PATH}`,
    }),
  );

  // Drop the code from the address bar so a reload does not try to redeem it twice.
  globalThis.history.replaceState({}, '', PUBLISHER_PATH);
}

/** In `alb` mode the cookie does the work; the one path that issues it is the sign-in. */
async function ensureAlbSession(config: PublisherConfig): Promise<boolean> {
  const response = await fetch(IDENTITY_PATH);
  if (response.status === UNAUTHORIZED) {
    globalThis.location.assign(config.signInPath ?? IDENTITY_PATH);
    return false;
  }

  return response.ok;
}

/**
 * Asks the gateway what repository it serves, then starts the editor.
 *
 * The token is attached here rather than left to the `fetch` wrapper. That wrapper authorises the
 * adapter endpoint and nothing else, because it is installed globally and Decap is not the only
 * thing on the page that calls `fetch`; this request knows its own credential and can say so.
 * In `alb` mode there is no token and the session cookie travels by itself.
 *
 * @param token - The author's access token, when there is one.
 */
async function startEditor(token: string | undefined): Promise<void> {
  const response = await fetch(CMS_CONFIG_PATH, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new SignInError('Signed in, but the gateway would not describe its repository.');
  }

  const cms = (await response.json()) as GatewayCmsConfig;
  status('');
  // Before `init`, which is when Decap reads the registry. Registering afterwards leaves the first
  // preview an author opens unstyled.
  CMS.registerPreviewStyle(PREVIEW_STYLE, { raw: true });
  CMS.init({ config: decapConfig(cms) });
}

async function main(): Promise<void> {
  const configResponse = await fetch(PUBLISHER_CONFIG_PATH);
  const outcome = classifyConfigResponse(configResponse);
  if (outcome !== 'configured') {
    // Dead ends rather than waits, all three: none of them resolves by being waited on, and only
    // `unreachable` resolves by being reloaded.
    status(CONFIG_FAILURE_MESSAGE[outcome], 'failed');
    return;
  }

  const config = (await configResponse.json()) as PublisherConfig;

  if (config.authMode === 'alb') {
    if (await ensureAlbSession(config)) {
      await startEditor(undefined);
    }
    return;
  }

  const session = createPublisherSession(globalThis.sessionStorage);
  globalThis.fetch = authorizingFetch({
    fetch: globalThis.fetch.bind(globalThis),
    token: () => session.readToken()?.token,
    path: PROXY_PATH,
    origin: globalThis.location.origin,
  });

  if (session.readToken() === undefined) {
    const isCallback = new URLSearchParams(globalThis.location.search).size > 0;
    if (isCallback) {
      await completeSignIn(config, session);
    } else {
      await beginSignIn(config, session);
      return;
    }
  }

  await startEditor(session.readToken()?.token);
}

main().catch((error: unknown) => {
  status(
    error instanceof Error ? error.message : 'The documentation CMS could not start.',
    'failed',
  );
});
