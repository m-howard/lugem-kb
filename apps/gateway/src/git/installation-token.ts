import { SignJWT } from 'jose';

import { type AppKeyLoader } from './app-key';

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

/**
 * How far before expiry a cached token is treated as spent (requirements.md R2: "refreshing at
 * least 5 minutes before expiry"). Installation tokens last an hour, so this costs nothing and
 * removes the class of failure where a token expires mid-request.
 */
const REFRESH_SKEW_MINUTES = 5;
const REFRESH_SKEW_MS = REFRESH_SKEW_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;

/** GitHub rejects an app JWT living longer than 10 minutes. Nine leaves room for clock drift. */
const APP_JWT_LIFETIME_MINUTES = 9;
const APP_JWT_LIFETIME_SECONDS = APP_JWT_LIFETIME_MINUTES * SECONDS_PER_MINUTE;

/** GitHub's own guidance: backdate `iat` to tolerate a fast clock on this side. */
const APP_JWT_BACKDATE_SECONDS = SECONDS_PER_MINUTE;

export interface InstallationTokenSourceOptions {
  readonly appId: string;
  readonly installationId: string;
  readonly loadPrivateKey: AppKeyLoader;
  readonly apiBaseUrl: string;
  /** Test seams. Neither is stubbed in production. */
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly now?: (() => number) | undefined;
}

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}

/**
 * The gateway's one credential at the git host (requirements.md R2).
 *
 * No author credential ever reaches GitHub: every editorial call is made with an installation
 * token minted here, from a private key the container reads at runtime and never holds on disk.
 *
 * Three behaviours are load-bearing rather than incidental, and each is a test:
 *
 * - **Early refresh.** A token within {@link REFRESH_SKEW_MS} of expiry is treated as spent, so a
 *   long request cannot start with a valid token and finish with an expired one.
 * - **Single flight.** Concurrent callers during a refresh share one in-flight mint. Without this,
 *   a burst after a deploy mints one token per concurrent request — GitHub rate-limits that, and
 *   every token but the last is wasted.
 * - **Explicit invalidation.** {@link invalidate} lets the caller that saw a 401 discard the cache
 *   and retry once, which is how a token revoked early stops being a permanent outage.
 */
export class InstallationTokenSource {
  readonly #options: InstallationTokenSourceOptions;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  #cached: CachedToken | undefined;
  #inFlight: Promise<string> | undefined;

  constructor(options: InstallationTokenSourceOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Returns a usable installation token, minting one only when the cached token is spent.
   *
   * @returns The token, valid for at least {@link REFRESH_SKEW_MS} longer.
   * @throws {Error} When the git host refuses to mint one.
   */
  async token(): Promise<string> {
    const cached = this.#cached;
    if (cached !== undefined && this.#now() < cached.expiresAt - REFRESH_SKEW_MS) {
      return cached.token;
    }

    this.#inFlight ??= this.#mint().finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  /** Discards the cached token, so the next call mints a fresh one. Used after an upstream 401. */
  invalidate(): void {
    this.#cached = undefined;
  }

  /**
   * Backs `/readyz`: a task that cannot mint a token cannot serve the CMS and should not join the
   * target group (requirements.md R10).
   *
   * @returns `true` when a token could be obtained; throws the underlying failure otherwise.
   */
  async checkCredential(): Promise<boolean> {
    await this.token();
    return true;
  }

  async #mint(): Promise<string> {
    const response = await this.#fetch(
      `${this.#options.apiBaseUrl}/app/installations/${encodeURIComponent(this.#options.installationId)}/access_tokens`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await this.#appJwt()}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `Minting an installation token returned ${String(response.status)}. Check the app id, ` +
          'the installation id, and that the private key belongs to that app.',
      );
    }

    const body = (await response.json()) as { token?: unknown; expires_at?: unknown };
    if (typeof body.token !== 'string' || typeof body.expires_at !== 'string') {
      throw new Error('The git host returned an installation token in an unexpected shape.');
    }

    this.#cached = { token: body.token, expiresAt: Date.parse(body.expires_at) };
    return body.token;
  }

  async #appJwt(): Promise<string> {
    const issuedAt = Math.floor(this.#now() / MS_PER_SECOND) - APP_JWT_BACKDATE_SECONDS;

    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(this.#options.appId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + APP_JWT_LIFETIME_SECONDS)
      .sign(await this.#options.loadPrivateKey());
  }
}
