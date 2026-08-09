import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';

import { type AppEnv } from '../app-env';
import { type AnswerOutcome, type Answerer } from '../kb/answer';

const BAD_REQUEST = 400;
const MAX_QUESTION_LENGTH = 1000;
const MAX_HISTORY_MESSAGES = 10;
const MAX_HISTORY_MESSAGE_LENGTH = 4000;

const historyMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(MAX_HISTORY_MESSAGE_LENGTH),
});

/**
 * Bedrock requires turns to alternate and to start with the reader. Enforcing it here turns a
 * client bug into a 400 naming the problem, instead of a ValidationException surfacing as a 500.
 */
function alternatesFromTheReader(history: { role: string }[]): boolean {
  return history.every(
    (message, index) => message.role === (index % 2 === 0 ? 'user' : 'assistant'),
  );
}

const askRequestSchema = z.object({
  question: z.string().trim().min(1).max(MAX_QUESTION_LENGTH),
  history: z
    .array(historyMessageSchema)
    .max(MAX_HISTORY_MESSAGES)
    .default([])
    .refine(alternatesFromTheReader, {
      message: 'History must alternate, starting with a user message.',
    }),
});

export interface AskRoutesOptions {
  readonly answerer: Answerer;
}

function streamAnswer(
  c: Context<AppEnv>,
  outcome: Extract<AnswerOutcome, { covered: true }>,
): Response {
  const logger = c.get('logger');
  const startedAt = Date.now();

  return streamSSE(c, async (stream) => {
    // Citations first, always. It makes R20's "every answer carries at least one citation"
    // structural rather than hopeful, lets the reader see the sources while the prose is still
    // arriving, and puts a byte on the wire before the model's time-to-first-token can run down
    // the ALB idle timer.
    await stream.writeSSE({ event: 'citations', data: JSON.stringify(outcome.citations) });

    try {
      for await (const chunk of outcome.chunks) {
        await stream.writeSSE({ event: 'token', data: JSON.stringify({ text: chunk }) });
      }
    } catch (error) {
      // The status line went out with the citations frame, so this cannot be a 500. The client
      // learns from the event type instead.
      logger.error(
        { err: error instanceof Error ? error.message : String(error), decision: 'answer-failed' },
        'answer generation failed mid-stream',
      );
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: 'answer_failed' }) });
      return;
    }

    logger.info(
      {
        decision: 'answered',
        citationCount: outcome.citations.length,
        inputTokens: outcome.stats.inputTokens,
        outputTokens: outcome.stats.outputTokens,
        totalMs: Date.now() - startedAt,
      },
      'answered from the corpus',
    );
    await stream.writeSSE({ event: 'done', data: JSON.stringify({ ok: true }) });
  });
}

/**
 * Grounded answering over the published corpus.
 *
 * Two response shapes, chosen before anything is streamed. When retrieval finds nothing above the
 * threshold the reply is plain JSON, byte-identical to `/v1/search`'s no-coverage body — no
 * stream is opened and no model is called, so declining stays cheap. Only an answerable question
 * gets `text/event-stream`.
 *
 * Question text, history and answer text are never logged. The corpus contains people-ops
 * content, so "how do I report my manager" is a disclosure about the asker even though the page
 * it retrieves is internally public (requirements.md R22, open question Q11). Counts and timings
 * are logged; content is not.
 *
 * @param options - The answerer backing the route.
 * @returns A Hono app exposing `POST /`.
 */
export function createAskRoutes(options: AskRoutesOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/', async (c) => {
    const parsed = askRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: 'invalid_request', detail: 'A non-empty question is required.' },
        BAD_REQUEST,
      );
    }

    const outcome = await options.answerer.answer(parsed.data, c.req.raw.signal);

    if (!outcome.covered) {
      c.get('logger').info(
        { decision: 'no-coverage' },
        'retrieval returned nothing above the relevance threshold',
      );
      return c.json({ covered: false, message: 'No documentation covers this question.' });
    }

    return streamAnswer(c, outcome);
  });

  return app;
}
