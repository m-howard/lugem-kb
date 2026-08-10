import { describe, expect, it } from 'vitest';

import { buildTestApp } from '../helpers/build-test-app';
import { collectingRecorder, type CollectingRecorder } from '../helpers/fake-feedback';

const ANSWER_ID = '3f1c8a44-9d2e-4c7b-8f10-2b6a5e9c1d33';

const VALID_BODY = {
  answerId: ANSWER_ID,
  question: 'how much notice do I give?',
  citedPaths: ['people/leave.md'],
  reason: 'It quoted the wrong policy.',
};

async function send(feedback: CollectingRecorder | undefined, body: unknown): Promise<Response> {
  return buildTestApp(feedback === undefined ? {} : { feedback }).request('/v1/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /v1/feedback', () => {
  it('records an unhelpful mark and accepts it', async () => {
    const feedback = collectingRecorder();

    const response = await send(feedback, VALID_BODY);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ recorded: true });
    expect(feedback.events).toEqual([
      {
        kind: 'unhelpful',
        answerId: ANSWER_ID,
        question: 'how much notice do I give?',
        citedPaths: ['people/leave.md'],
        reason: 'It quoted the wrong policy.',
      },
    ]);
  });

  it('accepts a mark with no reason, because demanding one collects nothing', async () => {
    const feedback = collectingRecorder();

    const response = await send(feedback, { answerId: ANSWER_ID, question: 'anything?' });

    expect(response.status).toBe(202);
    expect(feedback.events[0]).toMatchObject({ reason: undefined, citedPaths: [] });
  });

  it.each([
    ['a missing answer id', { question: 'anything?' }],
    ['an answer id that is not a uuid', { answerId: 'not-a-uuid', question: 'anything?' }],
    ['a missing question', { answerId: ANSWER_ID }],
    ['an empty question', { answerId: ANSWER_ID, question: '   ' }],
    ['a body that is not JSON at all', undefined],
  ])('refuses %s', async (_case, body) => {
    const feedback = collectingRecorder();

    const response = await send(feedback, body);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_request' });
    expect(feedback.events).toEqual([]);
  });

  // The body is reader-supplied and its contents end up in a GitHub issue a docs lead reads. A
  // caller must not be able to put a path of their choosing — or anything that is not a corpus
  // page at all — into that report.
  it('drops cited paths that do not resolve inside the corpus, and keeps the rest', async () => {
    const feedback = collectingRecorder();

    await send(feedback, {
      ...VALID_BODY,
      citedPaths: [
        'people/leave.md',
        '../../.github/workflows/ci.yml',
        '/etc/passwd',
        'not-a-markdown-file.txt',
      ],
    });

    expect(feedback.events[0]).toMatchObject({ citedPaths: ['people/leave.md'] });
  });

  it('refuses more cited paths than an answer could ever have carried', async () => {
    const feedback = collectingRecorder();

    const response = await send(feedback, {
      ...VALID_BODY,
      citedPaths: ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md'],
    });

    expect(response.status).toBe(400);
  });

  // Mirrors the CMS: an unconfigured deployment has no such surface at all, rather than one that
  // accepts a reader's words and drops them.
  it('is not mounted when no feedback table is configured', async () => {
    const response = await send(undefined, VALID_BODY);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'not_found' });
  });
});
