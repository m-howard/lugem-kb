import { describe, expect, it } from 'vitest';

import { buildTestApp } from '../helpers/build-test-app';
import { collectingRecorder } from '../helpers/fake-feedback';

const STRONG_MATCH = {
  text: 'Submit leave requests in Workday at least two weeks in advance.',
  uri: 's3://test-corpus/docs/people/leave.md',
  score: 0.91,
};

async function post(app: ReturnType<typeof buildTestApp>, body: unknown): Promise<Response> {
  return await app.request('/v1/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const LEAVE_PAGE = '---\ntitle: Leave\nlast_reviewed: 2026-06-15\n---\n\n# Leave\n';

describe('POST /v1/search', () => {
  it('returns citations for a covered question', async () => {
    const app = buildTestApp({
      retrievalResults: [STRONG_MATCH],
      objects: { 'docs/people/leave.md': LEAVE_PAGE },
    });
    const response = await post(app, { question: 'how do I request leave?' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      covered: true,
      citations: [
        {
          text: STRONG_MATCH.text,
          sourceUri: STRONG_MATCH.uri,
          score: 0.91,
          path: 'people/leave.md',
          url: '/people/leave',
          lastReviewed: '2026-06-15',
        },
      ],
    });
  });

  // A citation the reader cannot open is only checkable by someone with bucket access, which
  // defeats the point of citing it.
  it('resolves each citation to the page a reader can open', async () => {
    const app = buildTestApp({ retrievalResults: [STRONG_MATCH] });
    const body = (await (await post(app, { question: 'leave' })).json()) as {
      citations: { url: string | null }[];
    };

    expect(body.citations[0]?.url).toBe('/people/leave');
  });

  it('leaves the page fields null when the source is outside this corpus', async () => {
    const app = buildTestApp({
      retrievalResults: [{ ...STRONG_MATCH, uri: 's3://somewhere-else/notes.md' }],
    });
    const body = (await (await post(app, { question: 'leave' })).json()) as {
      citations: { url: string | null; path: string | null; text: string }[];
    };

    expect(body.citations[0]).toMatchObject({ url: null, path: null, text: STRONG_MATCH.text });
  });

  it('returns the passage verbatim, so the reader can check the claim against the source', async () => {
    const app = buildTestApp({ retrievalResults: [STRONG_MATCH] });
    const body = (await (await post(app, { question: 'leave' })).json()) as {
      citations: { text: string }[];
    };

    expect(body.citations[0]?.text).toBe(STRONG_MATCH.text);
  });

  // R20: when nothing is above the threshold the reader is told plainly. The response shape is
  // distinct — no `citations` key at all — so a client cannot render an empty list as an answer.
  describe('no coverage', () => {
    it('says so when retrieval returns nothing', async () => {
      const app = buildTestApp({ retrievalResults: [] });
      const response = await post(app, { question: 'what is our policy on unicorns?' });

      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toEqual({ covered: false, message: 'No documentation covers this question.' });
      expect(body).not.toHaveProperty('citations');
    });

    it('discards weak matches rather than presenting them as answers', async () => {
      const app = buildTestApp({
        retrievalResults: [{ text: 'Vaguely related.', uri: 's3://c/docs/other.md', score: 0.1 }],
      });
      const response = await post(app, { question: 'unrelated question' });

      await expect(response.json()).resolves.toMatchObject({ covered: false });
    });

    // R23. This route generates no answer, so it takes no part in unhelpful feedback — but a
    // question it cannot serve is the same gap `/v1/ask` would have recorded, and worth the same.
    it('records the gap, naming this route', async () => {
      const feedback = collectingRecorder();
      const app = buildTestApp({ retrievalResults: [], feedback });

      await post(app, { question: 'what is our policy on unicorns?' });

      expect(feedback.events).toEqual([
        {
          kind: 'no-coverage',
          route: '/v1/search',
          answerId: expect.any(String) as unknown,
          question: 'what is our policy on unicorns?',
          nearestSourceUri: undefined,
          nearestScore: undefined,
        },
      ]);
    });

    it('records nothing when passages were found', async () => {
      const feedback = collectingRecorder();
      const app = buildTestApp({
        retrievalResults: [STRONG_MATCH],
        objects: { 'docs/people/leave.md': LEAVE_PAGE },
        feedback,
      });

      await post(app, { question: 'how do I book leave?' });

      expect(feedback.events).toEqual([]);
    });
  });

  describe('request validation', () => {
    it.each([
      ['an empty question', { question: '' }],
      ['a whitespace-only question', { question: '    ' }],
      ['a missing question field', {}],
      ['a non-string question', { question: 42 }],
    ])('rejects %s with 400', async (_case, body) => {
      const response = await post(buildTestApp(), body);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: 'invalid_request' });
    });

    it('rejects a malformed JSON body without crashing the request', async () => {
      const response = await buildTestApp().request('/v1/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      });

      expect(response.status).toBe(400);
    });
  });

  it('does not accept GET, so questions cannot end up in access logs as query strings', async () => {
    const response = await buildTestApp().request('/v1/search?question=sensitive');

    expect(response.status).not.toBe(200);
  });
});
