/**
 * Everything the gateway owns, as prefixes.
 *
 * In production the gateway serves the site, so every call the browser makes is a relative path on
 * one origin. The rest is the site, which is the catch-all there too.
 *
 * `/idp` is not a production path. It is where `scripts/dev/serve-cms.ts` mounts its stub identity
 * provider, and forwarding it is what lets `/publisher` sign in: the discovery fetch and the token
 * exchange have to reach the same origin the page was served from, or they are cross-origin — and
 * there is no CORS anywhere in this repository, deliberately.
 */
const GATEWAY_PATHS = ['/v1', '/idp', '/previews', '/healthz', '/readyz'];

/** Where `bun run dev` puts the gateway. `dev:all` overrides it when it starts the sandbox. */
export const DEFAULT_GATEWAY_ORIGIN = 'http://127.0.0.1:3000';

/**
 * The dev server's proxy rules, in webpack-dev-server's array form.
 *
 * Without these, `docusaurus start` is a site with no API behind it: `/v1/ask` and
 * `/v1/publisher/config` are unknown paths, and the dev server answers every unknown path with the
 * site's own HTML and a 200. That is why the **Publisher** link used to lead to a dead end on
 * `:3001` — the editor asked how to sign an author in and was handed a web page.
 *
 * `changeOrigin` stays off on purpose. The stub identity provider redirects back to wherever the
 * browser said it came from, so the `Host` header has to survive the hop.
 *
 * @param gatewayOrigin - Where the gateway is listening. Defaults to {@link DEFAULT_GATEWAY_ORIGIN}.
 * @returns Rules to merge into the dev server configuration.
 */
export function gatewayProxyRules(
  gatewayOrigin: string = DEFAULT_GATEWAY_ORIGIN,
): readonly { context: readonly string[]; target: string; changeOrigin: boolean }[] {
  return [{ context: GATEWAY_PATHS, target: gatewayOrigin, changeOrigin: false }];
}
