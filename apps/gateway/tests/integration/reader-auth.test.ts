import { describe, expect, it } from 'vitest';

import { createBearerVerifier } from '../../src/auth/bearer-verifier';
import { buildTestApp } from '../helpers/build-test-app';
import { collectingRecorder } from '../helpers/fake-feedback';
import { fakeIdp, type FakeIdp } from '../helpers/fake-idp';

const STRONG_MATCH = {
  text: 'Submit leave requests in Workday at least two weeks in advance.',
  uri: 's3://test-corpus/docs/people/leave.md',
  score: 0.91,
};
const LEAVE_PAGE = '---\ntitle: Leave\nlast_reviewed: 2026-06-15\n---\n\n# Leave\n';

const READER_PATHS = ['/v1/ask', '/v1/search', '/v1/feedback'] as const;

async function buildProtectedApp(): Promise<{
  app: ReturnType<typeof buildTestApp>;
  idp: FakeIdp;
  authorize: () => Promise<Record<string, string>>;
}> {
  const idp = await fakeIdp();
  const app = buildTestApp({
    retrievalResults: [STRONG_MATCH],
    objects: { 'docs/people/leave.md': LEAVE_PAGE },
    feedback: collectingRecorder(),
    readerVerifier: createBearerVerifier({
      issuer: idp.issuer,
      audience: idp.audience,
      claimNames: { email: 'email', name: 'name' },
      keyResolver: idp.keyResolver,
    }),
  });

  return {
    app,
    idp,
    async authorize() {
      const token = await idp.sign({ sub: 'r1', email: 'ada@example.com', name: 'Ada Reader' });
      return { authorization: `Bearer ${token}` };
    },
  };
}

function bodyFor(path: string): string {
  if (path === '/v1/feedback') {
    return JSON.stringify({ answerId: crypto.randomUUID(), question: 'anything?' });
  }
  return JSON.stringify({ question: 'how do I book leave?' });
}

// requirements.md R22, built and default-off (ADR 0016). Two suites, and the second is the one
// that matters most: it proves the switch genuinely changes nothing when it is off.
describe('reader authentication, when required', () => {
  it.each(READER_PATHS)('refuses an unauthenticated %s with a reason', async (path) => {
    const { app } = await buildProtectedApp();

    const response = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: bodyFor(path),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: 'unauthorized',
      reason: 'missing-credential',
    });
  });

  it.each(READER_PATHS)('accepts an authenticated %s', async (path) => {
    const { app, authorize } = await buildProtectedApp();

    const response = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authorize()) },
      body: bodyFor(path),
    });

    expect([200, 202]).toContain(response.status);
  });

  // The reason `/v1/identity` exists. ALB mode needs exactly one path whose rule authenticates in
  // order to mint a session cookie, and `/v1/cms/identity` is not mounted without a CMS.
  it('reports who the reader is at /v1/identity', async () => {
    const { app, authorize } = await buildProtectedApp();

    const response = await app.request('/v1/identity', { headers: await authorize() });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      subject: 'r1',
      email: 'ada@example.com',
      name: 'Ada Reader',
    });
  });

  it('refuses /v1/identity without a credential, rather than reporting nobody', async () => {
    const { app } = await buildProtectedApp();

    expect((await app.request('/v1/identity')).status).toBe(401);
  });

  // Auth runs before the rate limiter, so the limiter can key on the subject. If the order ever
  // flips, a rejected request still consumes somebody's allowance.
  it('spends no model call on a request it refuses', async () => {
    const { app } = await buildProtectedApp();

    const response = await app.request('/v1/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'how do I book leave?' }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/json');
  });
});

// THE test for shipping this switched off. Everything above must be reachable in code and
// invisible in a default deployment — ADR 0013 left `/v1/ask` open deliberately, and R22 being
// buildable must not quietly change that for anyone who did not ask.
describe('reader authentication, when not required', () => {
  it.each(READER_PATHS)('leaves %s open', async (path) => {
    const app = buildTestApp({
      retrievalResults: [STRONG_MATCH],
      objects: { 'docs/people/leave.md': LEAVE_PAGE },
      feedback: collectingRecorder(),
    });

    const response = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: bodyFor(path),
    });

    expect(response.status).not.toBe(401);
    expect([200, 202]).toContain(response.status);
  });

  it('does not mount /v1/identity at all', async () => {
    const response = await buildTestApp({}).request('/v1/identity');

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'not_found' });
  });
});
