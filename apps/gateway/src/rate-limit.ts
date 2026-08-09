import { type MiddlewareHandler } from 'hono';

import { type AppEnv } from './app-env';

const TOO_MANY_REQUESTS = 429;
const WINDOW_MS = 60_000;
const MS_PER_SECOND = 1000;

/** Sweeping on write keeps the map bounded without a timer the test runner would have to wait on. */
const SWEEP_EVERY = 256;

interface Window {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  /** Requests allowed per client per minute. */
  readonly limit: number;
}

/**
 * The client's address as the ALB reports it. The first hop is the caller; later entries are
 * proxies, and anything downstream of the ALB can be forged, so only the first is trusted.
 */
function clientKey(forwardedFor: string | undefined): string {
  return forwardedFor?.split(',')[0]?.trim() ?? 'unknown';
}

/**
 * A fixed-window request limiter, keyed on client address.
 *
 * This exists because `/v1/ask` bills per question. Every other route in this service costs a
 * constant amount to serve, so an unauthenticated caller can only waste CPU; this one can spend
 * money, and a trivial loop against an internet-facing ALB is an unbounded bill.
 *
 * **This is a cost guard, not access control.** Two limits on it are worth stating plainly rather
 * than discovering:
 *
 * - The window is held in memory, per task. With `desiredCount: n` the effective ceiling is
 *   `n × limit`, and it resets on every deploy. Enforcing a real global limit needs a WAF
 *   rate-based rule or a shared store.
 * - It does not identify anyone. requirements.md R22 requires the endpoint to authenticate
 *   against the same IdP as `/admin`; no IdP exists in this project yet, and this does not
 *   substitute for one. See docs/adr/0010-grounded-generation-behind-retrieval.md.
 *
 * @param options - The per-client, per-minute allowance.
 * @returns Hono middleware answering 429 with `Retry-After` once a client is over.
 */
export function createRateLimit(options: RateLimitOptions): MiddlewareHandler<AppEnv> {
  const windows = new Map<string, Window>();
  let writes = 0;

  return async (c, next) => {
    const now = Date.now();

    writes += 1;
    if (writes % SWEEP_EVERY === 0) {
      for (const [key, window] of windows) {
        if (window.resetAt <= now) {
          windows.delete(key);
        }
      }
    }

    const key = clientKey(c.req.header('x-forwarded-for'));
    const existing = windows.get(key);
    const window =
      existing === undefined || existing.resetAt <= now
        ? { count: 0, resetAt: now + WINDOW_MS }
        : existing;

    window.count += 1;
    windows.set(key, window);

    if (window.count > options.limit) {
      const retryAfter = Math.ceil((window.resetAt - now) / MS_PER_SECOND);
      c.header('retry-after', String(retryAfter));
      return c.json({ error: 'rate_limited', retryAfterSeconds: retryAfter }, TOO_MANY_REQUESTS);
    }

    await next();
    return undefined;
  };
}
