import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type AppEnv } from './app-env';
import { createRateLimit } from './rate-limit';

const LIMIT = 3;
const WINDOW_MS = 60_000;

function appWithLimit(limit = LIMIT): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', createRateLimit({ limit }));
  app.get('/', (c) => c.json({ ok: true }));
  return app;
}

async function callFrom(app: Hono<AppEnv>, address: string): Promise<Response> {
  return app.request('/', { headers: { 'x-forwarded-for': address } });
}

/** Mirrors how `createApp` mounts reader auth: identity is set before the limiter runs. */
function appWithIdentity(limit = LIMIT): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    const subject = c.req.header('x-test-subject');
    if (subject !== undefined) {
      c.set('identity', { subject, email: `${subject}@example.com`, name: subject });
    }
    await next();
  });
  app.use('*', createRateLimit({ limit }));
  app.get('/', (c) => c.json({ ok: true }));
  return app;
}

async function callAs(app: Hono<AppEnv>, subject: string): Promise<Response> {
  return app.request('/', {
    // One shared address, as a whole office behind one NAT would present.
    headers: { 'x-forwarded-for': '203.0.113.7', 'x-test-subject': subject },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createRateLimit', () => {
  it('allows requests up to the limit', async () => {
    const app = appWithLimit();

    for (let attempt = 0; attempt < LIMIT; attempt += 1) {
      expect((await callFrom(app, '203.0.113.1')).status).toBe(200);
    }
  });

  it('refuses the request after the limit with 429 and a Retry-After header', async () => {
    const app = appWithLimit();
    for (let attempt = 0; attempt < LIMIT; attempt += 1) {
      await callFrom(app, '203.0.113.1');
    }

    const response = await callFrom(app, '203.0.113.1');

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: 'rate_limited', retryAfterSeconds: 60 });
    expect(response.headers.get('retry-after')).toBe('60');
  });

  it('lets the client through again once the window has passed', async () => {
    const app = appWithLimit();
    for (let attempt = 0; attempt <= LIMIT; attempt += 1) {
      await callFrom(app, '203.0.113.1');
    }

    vi.advanceTimersByTime(WINDOW_MS + 1);

    expect((await callFrom(app, '203.0.113.1')).status).toBe(200);
  });

  it('counts each client separately, so one caller cannot lock everyone out', async () => {
    const app = appWithLimit();
    for (let attempt = 0; attempt <= LIMIT; attempt += 1) {
      await callFrom(app, '203.0.113.1');
    }

    expect((await callFrom(app, '203.0.113.9')).status).toBe(200);
  });

  // Only the first hop is the caller. Everything after it was appended by a proxy, and anything
  // downstream of the ALB can be forged.
  it('keys on the first forwarded hop, ignoring appended proxy addresses', async () => {
    const app = appWithLimit();
    for (let attempt = 0; attempt <= LIMIT; attempt += 1) {
      await callFrom(app, '203.0.113.1, 10.0.0.7');
    }

    const response = await app.request('/', {
      headers: { 'x-forwarded-for': '203.0.113.1, 10.0.0.99' },
    });

    expect(response.status).toBe(429);
  });

  it('still limits a request with no forwarded-for header rather than exempting it', async () => {
    const app = appWithLimit();
    for (let attempt = 0; attempt <= LIMIT; attempt += 1) {
      await app.request('/');
    }

    expect((await app.request('/')).status).toBe(429);
  });

  it('does not grow without bound as clients come and go', async () => {
    const app = appWithLimit(1);

    for (let client = 0; client < 600; client += 1) {
      await callFrom(app, `203.0.113.${String(client)}`);
    }
    vi.advanceTimersByTime(WINDOW_MS + 1);
    // One more request past the sweep threshold retires every expired window.
    for (let client = 0; client < 300; client += 1) {
      await callFrom(app, `198.51.100.${String(client)}`);
    }

    expect((await callFrom(app, '203.0.113.1')).status).toBe(200);
  });
});

// R22, once reader authentication is on (ADR 0017). Before it, everyone behind one office NAT
// shared a window, so one enthusiastic colleague could exhaust the allowance for the floor.
describe('createRateLimit, with an authenticated reader', () => {
  it('gives each subject its own window, even behind one shared address', async () => {
    const app = appWithIdentity();

    for (let attempt = 0; attempt <= LIMIT; attempt += 1) {
      await callAs(app, 'ada');
    }

    expect((await callAs(app, 'ada')).status).toBe(429);
    expect((await callAs(app, 'grace')).status).toBe(200);
  });

  it('still counts an unauthenticated caller by address', async () => {
    const app = appWithIdentity();

    for (let attempt = 0; attempt <= LIMIT; attempt += 1) {
      await callFrom(app, '198.51.100.5');
    }

    expect((await callFrom(app, '198.51.100.5')).status).toBe(429);
  });

  // The key spaces are prefixed so a subject called `203.0.113.7` cannot spend an address's
  // allowance, or the other way round.
  it('keeps subject and address keys apart', async () => {
    const app = appWithIdentity();

    for (let attempt = 0; attempt <= LIMIT; attempt += 1) {
      await callAs(app, '203.0.113.7');
    }

    expect((await callAs(app, '203.0.113.7')).status).toBe(429);
    expect((await callFrom(app, '203.0.113.7')).status).toBe(200);
  });
});
