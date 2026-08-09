import { Hono } from 'hono';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { createApiNotFoundRoutes } from './api-not-found';
import { type AppEnv } from '../app-env';

const ELAPSED_MS = 40;

/** Mounts the terminator with a controllable clock, which an HTTP-level test cannot provide. */
function buildApp(options: { startedAt: number; identity?: AppEnv['Variables']['identity'] }) {
  const lines: Record<string, unknown>[] = [];
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('startedAt', options.startedAt);
    c.set(
      'logger',
      pino(
        { level: 'trace', formatters: { level: (label) => ({ level: label }) } },
        { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
      ),
    );
    if (options.identity !== undefined) {
      c.set('identity', options.identity);
    }
    await next();
  });
  app.route('/v1', createApiNotFoundRoutes());

  return { app, lines };
}

describe('createApiNotFoundRoutes', () => {
  it('answers JSON 404 rather than letting the site catch-all have it', async () => {
    const { app } = buildApp({ startedAt: Date.now() });

    const response = await app.request('/v1/nonsense');

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ error: 'not_found', path: '/v1/nonsense' });
  });

  // requirements.md R9. A constant would satisfy "the field is present" and tell an operator
  // nothing, so this asserts the value actually comes from the request clock.
  it('measures the duration from when the request entered the app', async () => {
    const { app, lines } = buildApp({ startedAt: Date.now() - ELAPSED_MS });

    await app.request('/v1/nonsense');

    expect(lines[0]?.['durationMs']).toBeGreaterThanOrEqual(ELAPSED_MS);
  });

  it('names the author when the request was authenticated on its way here', async () => {
    const identity = { subject: 'a1b2', email: 'sam@example.com', name: 'Sam Okoro' };
    const { app, lines } = buildApp({ startedAt: Date.now(), identity });

    await app.request('/v1/cms/nonsense');

    expect(lines[0]).toMatchObject({
      subject: 'a1b2',
      email: 'sam@example.com',
      decision: 'refused',
      reason: 'no-such-route',
      level: 'warn',
    });
  });

  // An unauthenticated caller was already refused and recorded by the auth middleware, so this
  // record simply has nobody to name — rather than inventing one.
  it('records the refusal with no author when there was none', async () => {
    const { app, lines } = buildApp({ startedAt: Date.now() });

    await app.request('/v1/nonsense');

    expect(lines[0]?.['subject']).toBeUndefined();
    expect(lines[0]).toMatchObject({ decision: 'refused', reason: 'no-such-route' });
  });
});
