import { type BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';
import { describe, expect, it, vi } from 'vitest';

import { Retriever } from './retrieve';

interface FakeResult {
  content?: { text?: string };
  location?: { s3Location?: { uri?: string } };
  score?: number;
}

function fakeClient(retrievalResults: FakeResult[] | undefined): BedrockAgentRuntimeClient {
  return {
    send: vi.fn().mockResolvedValue({ retrievalResults }),
  } as unknown as BedrockAgentRuntimeClient;
}

function result(text: string, uri: string, score: number): FakeResult {
  return { content: { text }, location: { s3Location: { uri } }, score };
}

const THRESHOLD = 0.4;

function retrieverOver(results: FakeResult[] | undefined): Retriever {
  return new Retriever({
    client: fakeClient(results),
    knowledgeBaseId: 'KB123',
    scoreThreshold: THRESHOLD,
  });
}

describe('Retriever', () => {
  it('returns citations that clear the threshold', async () => {
    const retriever = retrieverOver([
      result('Submit leave in Workday.', 's3://corpus/docs/leave.md', 0.9),
    ]);

    const outcome = await retriever.retrieve('how do I request leave?');

    expect(outcome).toEqual({
      covered: true,
      citations: [
        { text: 'Submit leave in Workday.', sourceUri: 's3://corpus/docs/leave.md', score: 0.9 },
      ],
    });
  });

  it('preserves passage text verbatim, which is what makes a citation checkable', async () => {
    const passage = 'Expenses over £50 need a receipt.\n\nSee the finance handbook.';
    const retriever = retrieverOver([result(passage, 's3://corpus/docs/expenses.md', 0.8)]);

    const outcome = await retriever.retrieve('expense limits');

    expect(outcome.covered && outcome.citations[0]?.text).toBe(passage);
  });

  // R20: when retrieval finds nothing above the threshold the reader is told plainly, rather
  // than handed a synthesised answer. The `covered: false` shape is what forces callers to
  // handle that case — an empty array would render as a successful answer with no sources.
  describe('no coverage', () => {
    it.each([
      ['no results at all', []],
      ['an undefined result list', undefined],
    ])('reports no coverage for %s', async (_case, results) => {
      const outcome = await retrieverOver(results).retrieve('what is our policy on unicorns?');
      expect(outcome).toEqual({
        covered: false,
        reason: 'no-documentation-covers-this',
        nearestMiss: undefined,
      });
    });

    it('discards results below the threshold rather than returning weak matches', async () => {
      const outcome = await retrieverOver([
        result('Loosely related text.', 's3://corpus/docs/other.md', 0.2),
      ]).retrieve('unrelated question');

      expect(outcome).toMatchObject({ covered: false, reason: 'no-documentation-covers-this' });
    });

    it('treats a result with no score as unscored, not as a perfect match', async () => {
      const outcome = await retrieverOver([
        { content: { text: 'Unscored.' }, location: { s3Location: { uri: 's3://c/d.md' } } },
      ]).retrieve('anything');

      expect(outcome).toMatchObject({ covered: false, reason: 'no-documentation-covers-this' });
    });

    // R23: a question the corpus does not cover still has to be attributable to somewhere, or a
    // gap report is a list of questions with nobody to send them to. The best sub-threshold hit
    // survives the filter for exactly that, and for nothing the reader ever sees.
    it('keeps the highest-scoring result that missed the threshold, to attribute the gap', async () => {
      const outcome = await retrieverOver([
        result('Loosely related.', 's3://corpus/docs/other.md', 0.2),
        result('Closer, still not enough.', 's3://corpus/docs/leave.md', 0.35),
        result('Least related.', 's3://corpus/docs/far.md', 0.05),
      ]).retrieve('unrelated question');

      expect(outcome).toEqual({
        covered: false,
        reason: 'no-documentation-covers-this',
        nearestMiss: { sourceUri: 's3://corpus/docs/leave.md', score: 0.35 },
      });
    });

    it('has no nearest miss when every result was unusable rather than merely weak', async () => {
      const outcome = await retrieverOver([
        { content: { text: 'Orphan, no URI.' }, score: 0.99 },
      ]).retrieve('anything');

      expect(outcome).toMatchObject({ covered: false, nearestMiss: undefined });
    });
  });

  it('keeps results exactly at the threshold', async () => {
    const outcome = await retrieverOver([
      result('Borderline.', 's3://corpus/docs/edge.md', THRESHOLD),
    ]).retrieve('edge case');

    expect(outcome.covered).toBe(true);
  });

  it('drops results missing a source URI, because an uncitable passage is not evidence', async () => {
    const outcome = await retrieverOver([
      { content: { text: 'Orphan passage.' }, score: 0.99 },
    ]).retrieve('anything');

    expect(outcome).toMatchObject({ covered: false, reason: 'no-documentation-covers-this' });
  });

  it('drops results missing text', async () => {
    const outcome = await retrieverOver([
      { location: { s3Location: { uri: 's3://c/d.md' } }, score: 0.99 },
    ]).retrieve('anything');

    expect(outcome).toMatchObject({ covered: false, reason: 'no-documentation-covers-this' });
  });

  it('keeps the good results when only some are unusable', async () => {
    const outcome = await retrieverOver([
      { content: { text: 'Orphan.' }, score: 0.99 },
      result('Real passage.', 's3://corpus/docs/real.md', 0.7),
      result('Too weak.', 's3://corpus/docs/weak.md', 0.1),
    ]).retrieve('anything');

    expect(outcome.covered).toBe(true);
    expect(outcome.covered && outcome.citations).toHaveLength(1);
    expect(outcome.covered && outcome.citations[0]?.sourceUri).toBe('s3://corpus/docs/real.md');
  });
});
