import { Hono } from 'hono';
import { z } from 'zod';

import { type AppEnv } from '../app-env';
import { type GapRecorder } from '../feedback/types';
import { type CitationViewer } from '../kb/citation-view';
import { type Retriever } from '../kb/retrieve';

const BAD_REQUEST = 400;
const MAX_QUESTION_LENGTH = 1000;

const searchRequestSchema = z.object({
  question: z.string().trim().min(1).max(MAX_QUESTION_LENGTH),
});

export interface SearchRoutesOptions {
  readonly retriever: Retriever;
  readonly viewer: CitationViewer;
  /** Absent when no feedback table is configured — gaps are then simply not recorded. */
  readonly recorder?: GapRecorder | undefined;
}

/**
 * Grounded retrieval over the published corpus.
 *
 * The no-coverage case gets its own shape — `{ covered: false }` with no `citations` key — so a
 * client cannot render an empty citation list as though it were an answer. Telling the reader
 * plainly that nothing covers their question is the required behaviour, not a degraded one
 * (requirements.md R20).
 *
 * Question text is deliberately not logged. The corpus contains people-ops content, so
 * "how do I report my manager" is a disclosure about the asker even though the page it retrieves
 * is internally public (requirements.md R22). It is still not logged — but a question this route
 * declines is now recorded to the feedback table, under the retention policy settled in
 * docs/adr/0016-recording-documentation-gaps.md (R23, open question Q11). A question that found
 * passages is never recorded.
 *
 * There is no answer to rate here, so this route takes no part in unhelpful feedback — the reader
 * has the passages and can judge them directly.
 *
 * @param options - The retriever backing the route, and the viewer that resolves citations to pages.
 * @returns A Hono app exposing `POST /`.
 */
export function createSearchRoutes(options: SearchRoutesOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/', async (c) => {
    const parsed = searchRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: 'invalid_request', detail: 'A non-empty question is required.' },
        BAD_REQUEST,
      );
    }

    const outcome = await options.retriever.retrieve(parsed.data.question);

    if (!outcome.covered) {
      c.get('logger').info(
        { decision: 'no-coverage' },
        'retrieval returned nothing above the relevance threshold',
      );
      // Belt and braces, as in `ask.ts`: recording a gap must never cost the reader their reply.
      await options.recorder
        ?.record(
          {
            kind: 'no-coverage',
            route: '/v1/search',
            answerId: crypto.randomUUID(),
            question: parsed.data.question,
            nearestSourceUri: outcome.nearestMiss?.sourceUri,
            nearestScore: outcome.nearestMiss?.score,
          },
          c.get('logger'),
        )
        .catch(() => undefined);
      return c.json({
        covered: false,
        message: 'No documentation covers this question.',
      });
    }

    return c.json({ covered: true, citations: await options.viewer.present(outcome.citations) });
  });

  return app;
}
