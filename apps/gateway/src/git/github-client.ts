import { checkEndpoint, type EndpointViolation } from './endpoint-policy';
import { type InstallationTokenSource } from './installation-token';

const UNAUTHORIZED = 401;
const NOT_FOUND = 404;
const NO_CONTENT = 204;

/** Thrown before any network I/O when a call is not on the allowlist — requirements.md R5. */
export class EndpointPolicyError extends Error {
  public readonly reason: EndpointViolation;

  constructor(reason: EndpointViolation, message: string) {
    super(message);
    this.name = 'EndpointPolicyError';
    this.reason = reason;
  }
}

/** Thrown when the git host refused a call the allowlist permitted. Carries the upstream status. */
export class GitHubError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

export interface GitHubClientOptions {
  readonly tokens: InstallationTokenSource;
  /** `owner/name`. Every path this client builds is scoped to it, and re-checked against it. */
  readonly repository: string;
  readonly apiBaseUrl: string;
  readonly allowMergeFromCms: boolean;
  /** Test seam. */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

export interface GitHubResponse<T> {
  readonly status: number;
  readonly body: T;
}

async function describeFailure(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    return typeof parsed.message === 'string' ? parsed.message : text;
  } catch {
    return text;
  }
}

/**
 * The only place in the service that calls the git host (requirements.md R2 and R5).
 *
 * Two guarantees follow from that being true, and both would evaporate if a second module started
 * making its own requests:
 *
 * - **Nothing outside the allowlist is ever sent.** The check runs before the token is even read,
 *   so a call the table does not name costs no credential use and no network.
 * - **No author credential reaches GitHub.** Every request is authenticated with the installation
 *   token and nothing else; the reader's own token never leaves the gateway.
 *
 * A 401 invalidates the cached token and retries exactly once. Once, not until it works: a
 * credential that has genuinely been revoked should surface as an error an operator sees, not as a
 * loop that hammers the git host on every request.
 */
export class GitHubClient {
  readonly #options: GitHubClientOptions;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: GitHubClientOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /** The repository every path is scoped to, for callers building one. */
  get repository(): string {
    return this.#options.repository;
  }

  /**
   * Builds a path scoped to the configured repository.
   *
   * Callers use this rather than interpolating the repository themselves, so there is one place
   * that decides which repository the credential acts on — and `checkEndpoint` re-derives it from
   * the finished path anyway, so a caller that ignored this would still be refused.
   *
   * @param suffix - Path below the repository, starting with `/`.
   * @returns The full path from `/repos/` onwards.
   */
  path(suffix: string): string {
    return `/repos/${this.#options.repository}${suffix}`;
  }

  /**
   * Makes one allowlisted call.
   *
   * @param method - HTTP method.
   * @param path - Path from `/repos/` onwards.
   * @param body - JSON body, for the methods that take one.
   * @returns The upstream status and parsed body.
   * @throws {EndpointPolicyError} When the call is not on the allowlist. Nothing is sent.
   * @throws {GitHubError} When the git host refused a permitted call.
   */
  async request<T>(method: string, path: string, body?: unknown): Promise<GitHubResponse<T>> {
    const decision = checkEndpoint(method, path, {
      repository: this.#options.repository,
      allowMergeFromCms: this.#options.allowMergeFromCms,
    });
    if (!decision.ok) {
      throw new EndpointPolicyError(decision.reason, decision.message);
    }

    const response = await this.#sendWithRetry(method, path, body);
    if (!response.ok) {
      throw new GitHubError(response.status, await describeFailure(response));
    }

    return {
      status: response.status,
      body: (response.status === NO_CONTENT ? undefined : await response.json()) as T,
    };
  }

  /**
   * Makes an allowlisted call, treating a 404 as an answer rather than a failure.
   *
   * Reading a draft branch that does not exist yet is the normal first step of creating one, so
   * the absence is information the caller wants, not an error it has to catch.
   *
   * @param path - Path from `/repos/` onwards.
   * @returns The parsed body, or `undefined` when the git host answered 404.
   */
  async getOrUndefined<T>(path: string): Promise<T | undefined> {
    try {
      return (await this.request<T>('GET', path)).body;
    } catch (error) {
      if (error instanceof GitHubError && error.status === NOT_FOUND) {
        return undefined;
      }
      throw error;
    }
  }

  async #sendWithRetry(method: string, path: string, body: unknown): Promise<Response> {
    const first = await this.#send(method, path, body);
    if (first.status !== UNAUTHORIZED) {
      return first;
    }

    this.#options.tokens.invalidate();
    return this.#send(method, path, body);
  }

  async #send(method: string, path: string, body: unknown): Promise<Response> {
    return this.#fetch(`${this.#options.apiBaseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.#options.tokens.token()}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
}
