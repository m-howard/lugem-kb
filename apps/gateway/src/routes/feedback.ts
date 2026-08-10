import { Hono } from 'hono';
import { z } from 'zod';

import { type AppEnv } from '../app-env';
import { type GapRecorder } from '../feedback/types';
import { resolveDocumentKey } from '../kb/key-policy';

const ACCEPTED = 202;
const BAD_REQUEST = 400;
const MAX_QUESTION_LENGTH = 1000;
const MAX_REASON_LENGTH = 500;
const MAX_CITED_PATHS = 5;

const feedbackRequestSchema = z.object({
  answerId: z.uuid(),
  question: z.string().trim().min(1).max(MAX_QUESTION_LENGTH),
  citedPaths: z.array(z.string().min(1)).max(MAX_CITED_PATHS).default([]),
  reason: z.string().trim().min(1).max(MAX_REASON_LENGTH).optional(),
});

export interface FeedbackRoutesOptions {
  readonly recorder: GapRecorder;
  /** Corpus prefix, used only to refuse cited paths that do not resolve inside the corpus. */
  readonly corpusPrefix: string;
}

/**
 * Records that an answer did not help.
 *
 * The reader posts back the question, the answer id they were given, and the pages they were
 * shown. There is no server-side conversation state (ADR 0012) and a successful answer is never
 * stored, so the gateway genuinely cannot reconstruct any of that on its own — which is why the
 * client sends it rather than just an id.
 *
 * That makes the body untrusted input. `citedPaths` is filtered through the same key policy the
 * document routes use, and anything that does not resolve inside the corpus is dropped rather than
 * refused: a reader should not get an error because the page list they were handed contained
 * something odd, and a report a docs lead reads must never contain a path a caller invented.
 *
 * Answers 202 rather than 201. Nothing was created that the caller can fetch, and the recorder
 * fails open by design, so a stronger promise would be an overclaim.
 *
 * @param options - The recorder to write through, and the corpus prefix cited paths must sit under.
 * @returns A Hono app exposing `POST /`.
 */
export function createFeedbackRoutes(options: FeedbackRoutesOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/', async (c) => {
    const parsed = feedbackRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid_request',
          detail: 'An answer id and the question it answered are required.',
        },
        BAD_REQUEST,
      );
    }

    const citedPaths = parsed.data.citedPaths.filter(
      (path) => resolveDocumentKey(path, { prefix: options.corpusPrefix }).ok,
    );

    await options.recorder.record(
      {
        kind: 'unhelpful',
        answerId: parsed.data.answerId,
        question: parsed.data.question,
        citedPaths,
        reason: parsed.data.reason,
      },
      c.get('logger'),
    );

    // Counts, never content. The reason is a reader's own words about their own situation, and it
    // is held in one place with a retention policy — not scattered through the logs as well.
    c.get('logger').info(
      {
        decision: 'gap-recorded',
        answerId: parsed.data.answerId,
        citedPathCount: citedPaths.length,
        hasReason: parsed.data.reason !== undefined,
      },
      'reader marked an answer unhelpful',
    );

    return c.json({ recorded: true }, ACCEPTED);
  });

  return app;
}
