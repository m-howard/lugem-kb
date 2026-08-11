#!/usr/bin/env bun
/**
 * One origin for local development, so the site's API calls work the way they will in production.
 *
 * The widget calls `/v1/ask` as a relative path because the gateway serves the site — same origin,
 * no base URL to configure, no CORS anywhere in this repo. Locally those are two processes on two
 * ports, and pointing the browser at the Docusaurus dev server directly would break that: the
 * fetch would be cross-origin, and the honest fix would be adding CORS to the gateway. That would
 * put a permanent production surface in place to solve a local problem, so this proxies instead.
 *
 * Run three things:
 *
 *   bun run dev                      # the gateway on :3000
 *   bun run docs:start               # Docusaurus with hot reload on :3001
 *   bun run scripts/dev/serve-dev.ts # this, on :4000 — open it in a browser
 *
 * Known limitation: Docusaurus's hot reload uses a WebSocket, and this forwards plain HTTP only.
 * Edits still rebuild; the browser needs a manual refresh, and the console logs a WebSocket error.
 * Bridging it is possible with `server.upgrade()` and not worth the code for a dev convenience.
 */
const DEFAULT_PORT = 4000;
const GATEWAY_ORIGIN = process.env['GATEWAY_ORIGIN'] ?? 'http://127.0.0.1:3000';
const SITE_ORIGIN = process.env['SITE_ORIGIN'] ?? 'http://127.0.0.1:3001';
const BAD_GATEWAY = 502;

/**
 * Everything the gateway owns. The rest is the site, which is the catch-all in production too.
 *
 * `/idp/` is not a production path: it is where `scripts/dev/serve-cms.ts` mounts its stub identity
 * provider. Forwarding it is what lets `/publisher` sign in through this proxy — the browser's
 * discovery fetch and token exchange have to reach the same origin the page is served from.
 */
const GATEWAY_PATHS = ['/v1/', '/healthz', '/readyz', '/previews/', '/idp/'];

function originFor(pathname: string): string {
  return GATEWAY_PATHS.some((prefix) => pathname.startsWith(prefix)) ? GATEWAY_ORIGIN : SITE_ORIGIN;
}

const port = Number(process.env['PORT'] ?? DEFAULT_PORT);

Bun.serve({
  port,
  fetch: async (request) => {
    const url = new URL(request.url);
    const target = `${originFor(url.pathname)}${url.pathname}${url.search}`;

    try {
      // The response body is returned as-is, so SSE passes through unbuffered — which is the
      // whole point of testing the widget behind this rather than against the site alone.
      return await fetch(target, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: 'manual',
        // Required when forwarding a streaming request body rather than a buffered one.
        duplex: 'half',
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return new Response(`Cannot reach ${target}: ${reason}\n`, { status: BAD_GATEWAY });
    }
  },
});

console.log(`dev proxy on http://127.0.0.1:${String(port)}`);
console.log(`  ${GATEWAY_PATHS.join(', ')} -> ${GATEWAY_ORIGIN}`);
console.log(`  everything else -> ${SITE_ORIGIN}`);
