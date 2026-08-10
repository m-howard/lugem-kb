import CMS from 'decap-cms-app';

import { discover, exchangeCode, SignInError } from './oidc-client';
import {
  buildAuthorizeUrl,
  codeChallenge,
  createCodeVerifier,
  createState,
  parseCallback,
} from './pkce';
import { type AdminSession, authorizingFetch, createAdminSession } from './session';

/**
 * The `/admin` page: sign in, then hand a configured Decap CMS an authorised `fetch`.
 *
 * The thin layer. Everything with a decision in it — deriving a challenge, matching a callback,
 * deciding which requests may carry the token — lives in `pkce.ts` and `session.ts`, where it is
 * unit-tested. What is left here is redirects and DOM, which Playwright covers end to end.
 */

const ADMIN_PATH = '/admin/';
const PROXY_PATH = '/v1/cms/proxy';
const ADMIN_CONFIG_PATH = '/v1/admin/config';
const CMS_CONFIG_PATH = '/v1/cms/config';
const IDENTITY_PATH = '/v1/cms/identity';
const NOT_FOUND = 404;
const UNAUTHORIZED = 401;

interface AdminConfig {
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

function status(message: string): void {
  const target = document.querySelector('#sign-in-status');
  if (target !== null) {
    target.textContent = message;
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

/** Starts an authorization-code flow, remembering the verifier this browser will need back. */
async function beginSignIn(config: AdminConfig, session: AdminSession): Promise<void> {
  const { authorizationEndpoint } = await discover(config.issuer ?? '');
  const verifier = createCodeVerifier();
  const state = createState();

  session.startFlight({ verifier, state });
  globalThis.location.assign(
    buildAuthorizeUrl(authorizationEndpoint, {
      clientId: config.clientId ?? '',
      redirectUri: `${globalThis.location.origin}${ADMIN_PATH}`,
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
async function completeSignIn(config: AdminConfig, session: AdminSession): Promise<void> {
  const callback = parseCallback(globalThis.location.search);
  if (!callback.ok) {
    throw new SignInError(callback.error);
  }

  const flight = session.readFlight();
  if (flight?.state !== callback.state) {
    throw new SignInError('This sign-in did not start in this browser. Try again.');
  }

  const { tokenEndpoint } = await discover(config.issuer ?? '');
  session.writeToken(
    await exchangeCode({
      tokenEndpoint,
      clientId: config.clientId ?? '',
      code: callback.code,
      verifier: flight.verifier,
      redirectUri: `${globalThis.location.origin}${ADMIN_PATH}`,
    }),
  );

  // Drop the code from the address bar so a reload does not try to redeem it twice.
  globalThis.history.replaceState({}, '', ADMIN_PATH);
}

/** In `alb` mode the cookie does the work; the one path that issues it is the sign-in. */
async function ensureAlbSession(config: AdminConfig): Promise<boolean> {
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
  CMS.init({ config: decapConfig(cms) });
}

async function main(): Promise<void> {
  const configResponse = await fetch(ADMIN_CONFIG_PATH);
  if (configResponse.status === NOT_FOUND) {
    status('The authoring CMS is not configured on this deployment.');
    return;
  }

  const config = (await configResponse.json()) as AdminConfig;

  if (config.authMode === 'alb') {
    if (await ensureAlbSession(config)) {
      await startEditor(undefined);
    }
    return;
  }

  const session = createAdminSession(globalThis.sessionStorage);
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
  status(error instanceof Error ? error.message : 'The documentation CMS could not start.');
});
