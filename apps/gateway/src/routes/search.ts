import { Hono } from 'hono';
import { z } from 'zod';

import { type AppEnv } from '../app-env';
import { type Retriever } from '../kb/retrieve';

const BAD_REQUEST = 400;
const MAX_QUESTION_LENGTH = 1000;

const searchRequestSchema = z.object({
  question: z.string().trim().min(1).max(MAX_QUESTION_LENGTH),
});

export interface SearchRoutesOptions {
  readonly retriever: Retriever;
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
 * is internally public (requirements.md R22, open question Q11).
 *
 * @param options - The retriever backing the route.
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
      return c.json({
        covered: false,
        message: 'No documentation covers this question.',
      });
    }

    return c.json({ covered: true, citations: outcome.citations });
  });

  return app;
}
