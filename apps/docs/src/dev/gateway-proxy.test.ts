import { describe, expect, it } from 'vitest';

import { DEFAULT_GATEWAY_ORIGIN, gatewayProxyRules } from './gateway-proxy';

const [RULE] = gatewayProxyRules();

describe('gatewayProxyRules', () => {
  it('forwards to the gateway `bun run dev` starts, by default', () => {
    expect(RULE.target).toBe(DEFAULT_GATEWAY_ORIGIN);
  });

  it('forwards to the gateway it is given', () => {
    expect(gatewayProxyRules('http://127.0.0.1:4300')[0]?.target).toBe('http://127.0.0.1:4300');
  });

  // Each of these is a path the browser calls on what it believes is one origin. A missing one is
  // a feature that works in production and dies on the dev server, which is the failure this list
  // exists to prevent — `/idp` most of all, since without it `/publisher` cannot sign anyone in.
  it.each(['/v1', '/idp', '/previews', '/healthz', '/readyz'])('forwards %s', (path) => {
    expect(RULE.context).toContain(path);
  });

  // The stub identity provider redirects back to wherever the browser said it came from, and it
  // reads that from the request. Rewriting the Host header would send an author to the gateway's
  // own port instead of the one they have open.
  it('leaves the Host header alone', () => {
    expect(RULE.changeOrigin).toBe(false);
  });

  // The site is the catch-all in production, so anything not listed has to fall through to
  // Docusaurus — including the corpus itself, which is served from `/`.
  it('does not forward the site', () => {
    expect(RULE.context).not.toContain('/');
  });
});
