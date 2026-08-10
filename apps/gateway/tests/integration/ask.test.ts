import { describe, expect, it } from 'vitest';

import { buildTestApp, type TestAppOptions } from '../helpers/build-test-app';
import { collectingRecorder } from '../helpers/fake-feedback';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const WEAK_MATCH = {
  text: 'Unrelated passage about something else entirely.',
  uri: 's3://test-corpus/docs/adr/0003-serve-the-site-from-ecs.md',
  score: 0.12,
};

const STRONG_MATCH = {
  text: 'The stack consumes an existing VPC and never creates one.',
  uri: 's3://test-corpus/docs/adr/0006-existing-vpc.md',
  score: 0.87,
};

const ADR_PAGE = '---\ntitle: 0006 — Existing VPC\nlast_reviewed: 2026-08-09\n---\n\n# ADR 0006\n';

const COVERED: TestAppOptions = {
  retrievalResults: [STRONG_MATCH],
  objects: { 'docs/adr/0006-existing-vpc.md': ADR_PAGE },
};

interface Frame {
  readonly event: string;
  readonly data: unknown;
}

/** Parses a whole SSE body into frames. Ordering assertions get their own incremental test below. */
function parseFrames(body: string): Frame[] {
  return body
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map((block) => {
      const lines = block.split('\n');
      const event = lines
        .find((line) => line.startsWith('event:'))
        ?.slice('event:'.length)
        .trim();
      const data = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .join('');
      return { event: event ?? '', data: JSON.parse(data) as unknown };
    });
}

async function ask(options: TestAppOptions, body: unknown): Promise<Response> {
  return buildTestApp(options).request('/v1/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const QUESTION = { question: 'how do I deploy into an existing VPC?' };

describe('POST /v1/ask', () => {
  it('streams an answer with its citations', async () => {
    const response = await ask(
      { ...COVERED, answer: { chunks: ['The stack ', 'uses your VPC. [1]'] } },
      QUESTION,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const frames = parseFrames(await response.text());

    expect(frames.map((frame) => frame.event)).toEqual(['citations', 'token', 'token', 'done']);
    // The citations frame also carries the answer id the reader posts back to `/v1/feedback` —
    // a handle for rating this answer, not a session, and nothing arrives before it.
    expect(frames[0]?.data).toEqual({
      answerId: expect.stringMatching(UUID_PATTERN) as unknown,
      citations: [
        {
          sourceUri: STRONG_MATCH.uri,
          path: 'adr/0006-existing-vpc.md',
          url: '/adr/0006-existing-vpc',
          text: STRONG_MATCH.text,
          score: 0.87,
          lastReviewed: '2026-08-09',
        },
      ],
    });
    expect(
      frames
        .slice(1, -1)
        .map((frame) => (frame.data as { text: string }).text)
        .join(''),
    ).toBe('The stack uses your VPC. [1]');
  });

  // The ordering guarantee, read incrementally rather than after the fact. Citations must be on
  // the wire before any prose: it makes R20's "every answer carries at least one citation"
  // structural, and it puts a byte out before the model's first token can run down the ALB's
  // idle timer.
  it('sends the citations frame before any answer text', async () => {
    const response = await ask({ ...COVERED, answer: { chunks: ['Answer.'] } }, QUESTION);
    const body = response.body as ReadableStream<Uint8Array> | null;
    const reader = body?.getReader();
    const first = await reader?.read();

    expect(new TextDecoder().decode(first?.value)).toContain('event: citations');

    await reader?.cancel();
  });

  it('accepts conversation history and answers the latest question', async () => {
    const response = await ask(COVERED, {
      question: 'and the subnets?',
      history: [
        { role: 'user', content: 'what is S3 Vectors?' },
        { role: 'assistant', content: 'The vector store behind the knowledge base.' },
      ],
    });

    expect(response.status).toBe(200);
    expect(parseFrames(await response.text()).at(-1)?.event).toBe('done');
  });

  // The cheap path, and the safe one. No stream is opened, so the reply is ordinary JSON in the
  // same shape /v1/search uses — and no model was called to produce it.
  describe('no coverage', () => {
    it('answers with plain JSON and no citations key', async () => {
      const response = await ask({ retrievalResults: [] }, { question: 'unicorn policy?' });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');

      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toEqual({ covered: false, message: 'No documentation covers this question.' });
      expect(body).not.toHaveProperty('citations');
    });

    it('declines rather than answering from a weak match', async () => {
      const response = await ask(
        { retrievalResults: [{ text: 'Vaguely related.', uri: 's3://c/docs/x.md', score: 0.1 }] },
        QUESTION,
      );

      await expect(response.json()).resolves.toMatchObject({ covered: false });
    });
  });

  // R23. A question the corpus cannot answer is the demand signal the whole feedback loop exists
  // to collect — and the retention promise in ADR 0016 is the other half: an answered question is
  // never written anywhere, so these two tests have to hold together.
  describe('recording gaps', () => {
    it('records the declined question with the page it came closest to', async () => {
      const feedback = collectingRecorder();

      await ask(
        { retrievalResults: [WEAK_MATCH], feedback },
        { question: 'what is the travel per diem?' },
      );

      expect(feedback.events).toEqual([
        {
          kind: 'no-coverage',
          route: '/v1/ask',
          answerId: expect.stringMatching(UUID_PATTERN) as unknown,
          question: 'what is the travel per diem?',
          nearestSourceUri: WEAK_MATCH.uri,
          nearestScore: WEAK_MATCH.score,
        },
      ]);
    });

    // THE retention test. If this ever fails, every question a reader asks is being stored, and
    // the answer to Q11 recorded in ADR 0016 has quietly become untrue.
    it('records nothing at all when the question was answered', async () => {
      const feedback = collectingRecorder();

      await ask({ ...COVERED, feedback }, QUESTION);

      expect(feedback.events).toEqual([]);
    });

    it('still answers when the recorder is broken', async () => {
      const feedback = collectingRecorder({ failWith: 'table gone' });

      const response = await ask({ retrievalResults: [], feedback }, { question: 'anything?' });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ covered: false });
    });

    it('records nothing when no feedback table is configured', async () => {
      const response = await ask({ retrievalResults: [WEAK_MATCH] }, { question: 'anything?' });

      expect(response.status).toBe(200);
    });
  });

  // The stream's status line is already sent by the time generation fails, so the failure has to
  // reach the client as an event. A client seeing 200 with no `done` frame must not render a
  // half-finished answer as complete.
  describe('generation failure', () => {
    it('reports a failure that happens before any text as an error frame', async () => {
      const response = await ask(
        { ...COVERED, answer: { chunks: ['unused'], failBeforeStreaming: true } },
        QUESTION,
      );

      const frames = parseFrames(await response.text());
      expect(frames.map((frame) => frame.event)).toEqual(['citations', 'error']);
      expect(frames.at(-1)?.data).toEqual({ error: 'answer_failed' });
    });

    it('reports a mid-stream failure after the text it managed to send', async () => {
      const response = await ask(
        { ...COVERED, answer: { chunks: ['Partial ', 'answer'], failAfterChunks: 1 } },
        QUESTION,
      );

      const frames = parseFrames(await response.text());
      expect(frames.map((frame) => frame.event)).toEqual(['citations', 'token', 'error']);
    });
  });

  describe('request validation', () => {
    it.each([
      ['an empty question', { question: '' }],
      ['a whitespace-only question', { question: '   ' }],
      ['a missing question field', {}],
      ['a non-string question', { question: 42 }],
      ['a question over the length limit', { question: 'x'.repeat(1001) }],
      ['history that is not an array', { question: 'hi', history: 'nope' }],
      ['an unknown history role', { question: 'hi', history: [{ role: 'system', content: 'x' }] }],
      ['an empty history message', { question: 'hi', history: [{ role: 'user', content: '' }] }],
      [
        'history longer than the cap, which is also the cost control',
        {
          question: 'hi',
          history: Array.from({ length: 12 }, (_unused, index) => ({
            role: index % 2 === 0 ? 'user' : 'assistant',
            content: 'x',
          })),
        },
      ],
      // Bedrock requires alternating turns starting with the reader. Catching it here turns a
      // client bug into a 400 rather than a ValidationException surfacing as a 500.
      [
        'history that does not alternate',
        {
          question: 'hi',
          history: [
            { role: 'user', content: 'one' },
            { role: 'user', content: 'two' },
          ],
        },
      ],
      [
        'history that starts with the assistant',
        { question: 'hi', history: [{ role: 'assistant', content: 'unprompted' }] },
      ],
    ])('rejects %s with 400', async (_case, body) => {
      const response = await ask(COVERED, body);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: 'invalid_request' });
    });

    it('rejects a malformed JSON body without crashing the request', async () => {
      const response = await buildTestApp(COVERED).request('/v1/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      });

      expect(response.status).toBe(400);
    });

    it('does not accept GET, so questions cannot end up in access logs as query strings', async () => {
      const response = await buildTestApp(COVERED).request('/v1/ask?question=sensitive');

      expect(response.status).not.toBe(200);
    });
  });

  // This endpoint bills per question and is unauthenticated (requirements.md R22 is unmet). The
  // limit is a cost guard against an internet-facing ALB, not access control.
  describe('rate limiting', () => {
    it('refuses a client that exceeds the per-minute allowance', async () => {
      const app = buildTestApp({ ...COVERED, askRateLimitPerMinute: 2 });
      const send = async (): Promise<Response> =>
        app.request('/v1/ask', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.5' },
          body: JSON.stringify(QUESTION),
        });

      await (await send()).text();
      await (await send()).text();
      const third = await send();

      expect(third.status).toBe(429);
      expect(third.headers.get('retry-after')).toBeTruthy();
      await expect(third.json()).resolves.toMatchObject({ error: 'rate_limited' });
    });

    it('does not limit the read-only search endpoint, which costs nothing per call', async () => {
      const app = buildTestApp({ ...COVERED, askRateLimitPerMinute: 1 });
      const search = async (): Promise<Response> =>
        app.request('/v1/search', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.5' },
          body: JSON.stringify(QUESTION),
        });

      await (await search()).text();
      expect((await search()).status).toBe(200);
    });
  });
});
