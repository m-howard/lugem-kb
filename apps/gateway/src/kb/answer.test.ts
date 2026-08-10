import { type BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';
import { type BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { type S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';

import { type AnswerOutcome, Answerer, AnswerStreamError } from './answer';
import { CitationViewer } from './citation-view';
import { CorpusClient } from './corpus-client';
import { Retriever } from './retrieve';

const BUCKET = 'corpus';
const PREFIX = 'docs/';
const MODEL_ID = 'test.answer-model-v1:0';
const MAX_TOKENS = 700;
const THRESHOLD = 0.4;

const PASSAGE = 'The stack consumes an existing VPC and never creates one.';
const SOURCE_URI = `s3://${BUCKET}/docs/adr/0006-existing-vpc.md`;

function retrievalResults(score: number): unknown {
  return {
    retrievalResults: [
      { content: { text: PASSAGE }, location: { s3Location: { uri: SOURCE_URI } }, score },
    ],
  };
}

/** A corpus that answers every frontmatter read, so review dates are not the subject here. */
function fakeCorpus(): CorpusClient {
  const send = vi.fn(() =>
    Promise.resolve({
      Body: { transformToString: () => Promise.resolve('---\nlast_reviewed: 2026-08-09\n---\n') },
    }),
  );
  return new CorpusClient({ s3: { send } as unknown as S3Client, bucket: BUCKET, prefix: PREFIX });
}

interface StreamOptions {
  readonly events?: readonly unknown[];
  readonly rejectWith?: string;
  readonly omitStream?: boolean;
}

function textEvents(...texts: readonly string[]): readonly unknown[] {
  return texts.map((text) => ({ contentBlockDelta: { delta: { text } } }));
}

function build(options: { score?: number } & StreamOptions = {}): {
  answerer: Answerer;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(() => {
    if (options.rejectWith !== undefined) {
      return Promise.reject(new Error(options.rejectWith));
    }
    if (options.omitStream === true) {
      return Promise.resolve({});
    }
    const events = options.events ?? textEvents('An answer.');
    return Promise.resolve({
      // eslint-disable-next-line @typescript-eslint/require-await
      stream: (async function* stream() {
        yield* events;
      })(),
    });
  });

  const retrieval = vi.fn(() => Promise.resolve(retrievalResults(options.score ?? 0.9)));
  const corpus = fakeCorpus();

  return {
    send,
    answerer: new Answerer({
      client: { send } as unknown as BedrockRuntimeClient,
      retriever: new Retriever({
        client: { send: retrieval } as unknown as BedrockAgentRuntimeClient,
        knowledgeBaseId: 'KB-TEST',
        scoreThreshold: THRESHOLD,
      }),
      viewer: new CitationViewer({ corpus, location: { bucket: BUCKET, prefix: PREFIX } }),
      modelId: MODEL_ID,
      maxTokens: MAX_TOKENS,
    }),
  };
}

async function collect(outcome: AnswerOutcome): Promise<string> {
  if (!outcome.covered) {
    throw new Error('expected a covered outcome');
  }
  let text = '';
  for await (const chunk of outcome.chunks) {
    text += chunk;
  }
  return text;
}

const ASK = { question: 'how do I deploy into an existing VPC?', history: [] };

describe('Answerer', () => {
  // THE test. requirements.md R20 says a question the corpus does not cover is declined rather
  // than answered from background knowledge, and this is what enforces it: the model is never
  // reached, so it cannot answer. It is also the cost control — an off-corpus question costs one
  // retrieval, not a generation. If this test ever fails, both properties are gone.
  it('never calls the model when nothing clears the relevance threshold', async () => {
    const { answerer, send } = build({ score: 0.1 });

    const outcome = await answerer.answer({ question: 'unicorn policy?', history: [] });

    expect(outcome).toMatchObject({ covered: false, reason: 'no-documentation-covers-this' });
    expect(send).not.toHaveBeenCalled();
  });

  // R23: the route records the gap, and it can only name a documentation area if the near miss
  // survives the trip through the answerer rather than being dropped at this boundary.
  it('passes the nearest miss through, so the gap can be attributed', async () => {
    const { answerer } = build({ score: 0.1 });

    const outcome = await answerer.answer({ question: 'unicorn policy?', history: [] });

    expect(outcome).toMatchObject({
      covered: false,
      nearestMiss: { sourceUri: SOURCE_URI, score: 0.1 },
    });
  });

  // The model call lives inside the generator, so obtaining an outcome does not start it. A
  // client that disconnects between retrieval and the first read costs nothing.
  it('does not call the model until the chunks are iterated', async () => {
    const { answerer, send } = build();

    await answerer.answer(ASK);

    expect(send).not.toHaveBeenCalled();
  });

  it('streams the answer text', async () => {
    const { answerer } = build({ events: textEvents('The stack ', 'consumes an existing VPC.') });

    expect(await collect(await answerer.answer(ASK))).toBe('The stack consumes an existing VPC.');
  });

  it('resolves citations to their page and review date before answering', async () => {
    const outcome = await build().answerer.answer(ASK);

    expect(outcome.covered && outcome.citations).toEqual([
      {
        sourceUri: SOURCE_URI,
        path: 'adr/0006-existing-vpc.md',
        url: '/adr/0006-existing-vpc',
        text: PASSAGE,
        score: 0.9,
        lastReviewed: '2026-08-09',
      },
    ]);
  });

  describe('the request it sends', () => {
    it('puts the passages in the system block and the question in the user turn', async () => {
      const { answerer, send } = build();
      await collect(await answerer.answer(ASK));

      const { input } = send.mock.calls[0]?.[0] as {
        input: { system: { text: string }[]; messages: { role: string; content: unknown[] }[] };
      };

      expect(input.system[0]?.text).toContain(PASSAGE);
      expect(input.system[0]?.text).not.toContain(ASK.question);
      expect(input.messages).toEqual([{ role: 'user', content: [{ text: ASK.question }] }]);
    });

    it('threads conversation history through in order, question last', async () => {
      const { answerer, send } = build();
      await collect(
        await answerer.answer({
          question: 'and the subnets?',
          history: [
            { role: 'user', content: 'what is S3 Vectors?' },
            { role: 'assistant', content: 'The vector store.' },
          ],
        }),
      );

      const { input } = send.mock.calls[0]?.[0] as { input: { messages: { role: string }[] } };
      expect(input.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    });

    // Pinned deliberately. Current Anthropic models on Bedrock reject non-default sampling
    // parameters with a 400, so "helpfully" adding temperature: 0 breaks every request.
    it('sends maxTokens and no sampling parameters', async () => {
      const { answerer, send } = build();
      await collect(await answerer.answer(ASK));

      const { input } = send.mock.calls[0]?.[0] as {
        input: { modelId: string; inferenceConfig: Record<string, unknown> };
      };

      expect(input.modelId).toBe(MODEL_ID);
      expect(input.inferenceConfig).toEqual({ maxTokens: MAX_TOKENS });
    });

    it('passes the abort signal through, so a closed tab stops costing money', async () => {
      const { answerer, send } = build();
      const controller = new AbortController();

      await collect(await answerer.answer(ASK, controller.signal));

      expect(send.mock.calls[0]?.[1]).toEqual({ abortSignal: controller.signal });
    });
  });

  it('records token usage so the route can log what the question cost', async () => {
    const { answerer } = build({
      events: [
        ...textEvents('An answer.'),
        { metadata: { usage: { inputTokens: 1200, outputTokens: 42 } } },
      ],
    });

    const outcome = await answerer.answer(ASK);
    await collect(outcome);

    expect(outcome.covered && outcome.stats).toEqual({ inputTokens: 1200, outputTokens: 42 });
  });

  // A model with extended thinking on emits reasoning deltas. They are not an answer, and
  // showing a reader the model's scratchpad is not what the citations vouch for.
  it('yields only text deltas, skipping reasoning and tool-use blocks', async () => {
    const { answerer } = build({
      events: [
        { messageStart: { role: 'assistant' } },
        { contentBlockDelta: { delta: { reasoningContent: { text: 'thinking out loud' } } } },
        ...textEvents('The answer.'),
        { contentBlockDelta: { delta: { toolUse: { input: '{}' } } } },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { messageStop: { stopReason: 'end_turn' } },
      ],
    });

    expect(await collect(await answerer.answer(ASK))).toBe('The answer.');
  });

  // Bedrock reports some failures as members of the stream union rather than by rejecting.
  // Missing that turns a throttled request into a silently truncated answer.
  describe('surfaces every failure mode as one error type', () => {
    it.each([
      ['a throttling member mid-stream', { throttlingException: { message: 'slow down' } }],
      ['a validation member', { validationException: { message: 'bad model id' } }],
      ['a model stream error member', { modelStreamErrorException: { message: 'stream broke' } }],
      ['an internal server member', { internalServerException: { message: 'boom' } }],
      ['a service unavailable member', { serviceUnavailableException: { message: 'down' } }],
    ])('throws AnswerStreamError on %s', async (_case, failure) => {
      const { answerer } = build({ events: [...textEvents('Partial'), failure] });

      await expect(collect(await answerer.answer(ASK))).rejects.toThrow(AnswerStreamError);
    });

    it('throws AnswerStreamError when the SDK itself rejects', async () => {
      const { answerer } = build({ rejectWith: 'AccessDeniedException' });

      await expect(collect(await answerer.answer(ASK))).rejects.toThrow(AnswerStreamError);
    });

    it('throws AnswerStreamError when Bedrock returns no stream at all', async () => {
      const { answerer } = build({ omitStream: true });

      await expect(collect(await answerer.answer(ASK))).rejects.toThrow(AnswerStreamError);
    });

    it('carries the underlying reason, so an operator can act on it', async () => {
      const { answerer } = build({ rejectWith: 'AccessDeniedException on bedrock:InvokeModel' });

      await expect(collect(await answerer.answer(ASK))).rejects.toThrow(/AccessDeniedException/);
    });
  });
});
