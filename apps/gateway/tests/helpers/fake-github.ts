import { requestUrl } from './request-url';

export interface FakeGitHubCall {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

export interface FakeGitHubRoute {
  readonly method: string;
  /** Path from `/repos/` onwards, matched exactly or by pattern. */
  readonly path: string | RegExp;
  readonly status?: number;
  /** Body to answer with, or a function of the request body. */
  readonly respond?: unknown;
}

export interface FakeGitHub {
  readonly calls: readonly FakeGitHubCall[];
  readonly fetch: typeof globalThis.fetch;
  /** Calls that actually left, minus the token mint — what the allowlist is asserted against. */
  paths(): string[];
}

const OK = 200;
const CREATED = 201;
const NO_CONTENT = 204;

/**
 * A stand-in git host that answers only the calls a test declared.
 *
 * It **fails loudly on anything unlisted**, rather than returning a helpful empty object. That is
 * the same choice `fake-aws.ts` documents, and it matters more here: a test whose fake shrugged at
 * an unexpected `PUT /branches/main/protection` would pass while the gateway made exactly the call
 * requirements.md R5 exists to prevent.
 *
 * The installation-token mint is answered automatically, because every path through the client
 * needs one and asserting on it in each test would drown the interesting assertions.
 *
 * @param routes - The calls this test expects, in match order.
 * @returns The recorded calls and a `fetch` to inject.
 */
export interface FakeGitHubOptions {
  /** Status the installation-token mint answers with. 401 stands in for an unwritten PEM. */
  readonly mintStatus?: number;
}

export function fakeGitHub(
  routes: readonly FakeGitHubRoute[] = [],
  options: FakeGitHubOptions = {},
): FakeGitHub {
  const calls: FakeGitHubCall[] = [];

  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(requestUrl(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;

    calls.push({
      method,
      path: `${url.pathname}${url.search}`,
      authorization: headers['authorization'],
      body,
    });

    if (url.pathname.startsWith('/app/installations/')) {
      if (options.mintStatus !== undefined) {
        return Promise.resolve(
          Response.json({ message: 'Bad credentials' }, { status: options.mintStatus }),
        );
      }
      return Promise.resolve(
        Response.json({
          token: 'ghs_installation_token',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      );
    }

    const route = routes.find(
      (candidate) =>
        candidate.method.toUpperCase() === method &&
        (typeof candidate.path === 'string'
          ? candidate.path === url.pathname
          : candidate.path.test(url.pathname)),
    );

    if (route === undefined) {
      throw new Error(
        `The gateway made an unexpected call: ${method} ${url.pathname}. ` +
          'If that call is intended, declare it in the test; if it is not, that is the bug.',
      );
    }

    const payload =
      typeof route.respond === 'function'
        ? (route.respond as (value: unknown) => unknown)(body)
        : (route.respond ?? {});
    const status = route.status ?? (method === 'POST' ? CREATED : OK);

    // 204 must not carry a body — `Response.json` throws rather than letting one through, which
    // would turn a correct handler into a 500 that looks like the handler's fault.
    return Promise.resolve(
      status === NO_CONTENT ? new Response(null, { status }) : Response.json(payload, { status }),
    );
  }) as typeof globalThis.fetch;

  return {
    calls,
    fetch: fetchImpl,
    paths: () => calls.filter((call) => !call.path.startsWith('/app/')).map((call) => call.path),
  };
}
