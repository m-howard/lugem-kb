import {
  type BedrockRuntimeClient,
  ConverseStreamCommand,
  type ConverseStreamOutput,
  type Message,
} from '@aws-sdk/client-bedrock-runtime';

import { type CitationView, type CitationViewer } from './citation-view';
import { buildGroundingPrompt } from './grounding-prompt';
import { type Retriever } from './retrieve';

export interface ConversationMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface AnswerRequest {
  readonly question: string;
  readonly history: readonly ConversationMessage[];
}

/** Filled in when the stream's metadata event arrives, so the route can log what a question cost. */
export interface AnswerStats {
  inputTokens: number;
  outputTokens: number;
}

export type AnswerOutcome =
  | { readonly covered: false; readonly reason: 'no-documentation-covers-this' }
  | {
      readonly covered: true;
      readonly citations: readonly CitationView[];
      /** Lazy. The model is not called until this is iterated; abandoning it costs nothing. */
      readonly chunks: AsyncIterable<string>;
      readonly stats: AnswerStats;
    };

/** Thrown out of the chunk iterator so a route has one error type to catch, however Bedrock failed. */
export class AnswerStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnswerStreamError';
  }
}

export interface AnswererOptions {
  readonly client: BedrockRuntimeClient;
  readonly retriever: Retriever;
  readonly viewer: CitationViewer;
  readonly modelId: string;
  readonly maxTokens: number;
}

interface GenerateOptions {
  readonly system: string;
  readonly messages: readonly Message[];
  readonly stats: AnswerStats;
  readonly signal: AbortSignal | undefined;
}

/**
 * Bedrock reports some failures as members of the stream union rather than by rejecting. Both
 * happen in production, so both are checked; missing this one turns a throttled request into a
 * silently truncated answer.
 */
function toStreamFailure(event: ConverseStreamOutput): string | undefined {
  const exception =
    event.validationException ??
    event.throttlingException ??
    event.modelStreamErrorException ??
    event.internalServerException ??
    event.serviceUnavailableException;

  return exception?.message;
}

function toMessages(request: AnswerRequest): Message[] {
  return [
    ...request.history.map((message) => ({
      role: message.role,
      content: [{ text: message.content }],
    })),
    { role: 'user' as const, content: [{ text: request.question }] },
  ];
}

/**
 * Answers a question from the corpus, or declines.
 *
 * The shape of {@link answer} is the safety argument. It resolves as soon as retrieval does, and
 * the model call lives inside the returned generator — which does not execute until something
 * iterates it. So on the no-coverage path no command is constructed and nothing is sent to
 * Bedrock, and that is structural rather than a convention a later edit can quietly break. It is
 * also directly assertable: the runtime client's `send` was never called.
 *
 * Retrieval stays the gate. `RETRIEVAL_SCORE_THRESHOLD` and the `covered: false` union in
 * {@link Retriever} remain the enforcement point, so declining is a code path rather than an
 * instruction the model might ignore, and a question the corpus does not cover costs one
 * retrieval rather than a generation.
 *
 * Citations come from the retrieval results, fixed before generation starts — they are never
 * parsed out of the model's output, so a fabricated citation is not an available failure. The
 * worst the model can do is put a marker against the wrong source, and the reader has the
 * verbatim passage beside it to check.
 *
 * See docs/adr/0012-grounded-generation-behind-retrieval.md.
 */
export class Answerer {
  readonly #client: BedrockRuntimeClient;
  readonly #retriever: Retriever;
  readonly #viewer: CitationViewer;
  readonly #modelId: string;
  readonly #maxTokens: number;

  constructor(options: AnswererOptions) {
    this.#client = options.client;
    this.#retriever = options.retriever;
    this.#viewer = options.viewer;
    this.#modelId = options.modelId;
    this.#maxTokens = options.maxTokens;
  }

  /**
   * Retrieves, then prepares an answer over what was retrieved.
   *
   * @param request - The reader's question and the conversation so far.
   * @param signal - Aborts the model call when the reader goes away, so a closed tab stops costing money.
   * @returns Citations and a lazy chunk stream, or an explicit no-coverage outcome.
   *
   * @example
   * ```ts
   * const outcome = await answerer.answer({ question, history: [] });
   * if (!outcome.covered) return c.json({ covered: false, message });
   * for await (const chunk of outcome.chunks) { ... }
   * ```
   */
  async answer(request: AnswerRequest, signal?: AbortSignal): Promise<AnswerOutcome> {
    const retrieved = await this.#retriever.retrieve(request.question);
    if (!retrieved.covered) {
      return { covered: false, reason: retrieved.reason };
    }

    const citations = await this.#viewer.present(retrieved.citations);
    const stats: AnswerStats = { inputTokens: 0, outputTokens: 0 };

    return {
      covered: true,
      citations,
      stats,
      chunks: this.#generate({
        system: buildGroundingPrompt(citations),
        messages: toMessages(request),
        stats,
        signal,
      }),
    };
  }

  async *#generate(options: GenerateOptions): AsyncGenerator<string> {
    const response = await this.#client
      .send(
        new ConverseStreamCommand({
          modelId: this.#modelId,
          system: [{ text: options.system }],
          messages: [...options.messages],
          // maxTokens and nothing else. Current Anthropic models on Bedrock reject non-default
          // sampling parameters outright, and "temperature: 0 for determinism" was never a
          // guarantee worth a 400 anyway. There is a test pinning this.
          inferenceConfig: { maxTokens: this.#maxTokens },
        }),
        ...(options.signal === undefined ? [] : [{ abortSignal: options.signal }]),
      )
      .catch((error: unknown) => {
        throw new AnswerStreamError(error instanceof Error ? error.message : String(error));
      });

    if (response.stream === undefined) {
      throw new AnswerStreamError('Bedrock accepted the request but returned no stream.');
    }

    yield* this.#readStream(response.stream, options.stats);
  }

  async *#readStream(
    stream: AsyncIterable<ConverseStreamOutput>,
    stats: AnswerStats,
  ): AsyncGenerator<string> {
    try {
      for await (const event of stream) {
        const failure = toStreamFailure(event);
        if (failure !== undefined) {
          throw new AnswerStreamError(failure);
        }

        const usage = event.metadata?.usage;
        if (usage !== undefined) {
          stats.inputTokens = usage.inputTokens ?? 0;
          stats.outputTokens = usage.outputTokens ?? 0;
        }

        // Only text deltas. A model with extended thinking enabled also emits reasoningContent
        // deltas, which are not an answer and must never reach the reader.
        const text = event.contentBlockDelta?.delta?.text;
        if (text !== undefined && text !== '') {
          yield text;
        }
      }
    } catch (error) {
      throw error instanceof AnswerStreamError
        ? error
        : new AnswerStreamError(error instanceof Error ? error.message : String(error));
    }
  }
}
