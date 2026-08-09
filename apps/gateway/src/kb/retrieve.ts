import {
  type BedrockAgentRuntimeClient,
  type KnowledgeBaseRetrievalResult,
  RetrieveCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';

/** Bedrock caps `numberOfResults` at 100; five is enough to cite without burying the reader. */
const DEFAULT_RESULT_COUNT = 5;

export interface Citation {
  /** Source document URI, e.g. `s3://bucket/docs/adr/0001-monorepo.md`. */
  readonly sourceUri: string;
  /** The retrieved passage, verbatim. Never paraphrased — this is what makes the citation checkable. */
  readonly text: string;
  readonly score: number;
}

export type RetrievalOutcome =
  | { readonly covered: true; readonly citations: readonly Citation[] }
  | { readonly covered: false; readonly reason: 'no-documentation-covers-this' };

export interface RetrieverOptions {
  readonly client: BedrockAgentRuntimeClient;
  readonly knowledgeBaseId: string;
  /** Results scoring below this are discarded rather than returned as weak matches. */
  readonly scoreThreshold: number;
  readonly resultCount?: number;
}

function toCitation(result: KnowledgeBaseRetrievalResult): Citation | undefined {
  const text = result.content?.text;
  const sourceUri = result.location?.s3Location?.uri;
  if (text === undefined || sourceUri === undefined) {
    return undefined;
  }
  return { sourceUri, text, score: result.score ?? 0 };
}

/**
 * Retrieval over the Bedrock knowledge base.
 *
 * Retrieval only — this deliberately does not call RetrieveAndGenerate, and still does not now
 * that answers are generated. `Answerer` in `kb/answer.ts` calls this first and only reaches a
 * model with passages that already cleared the threshold, so `RETRIEVAL_SCORE_THRESHOLD` and the
 * `covered: false` union below remain the enforcement point rather than a prompt instruction the
 * model might ignore. Returning the passages verbatim is what keeps every claim traceable to a
 * source.
 *
 * This contract is unchanged by generation, which is what the note here originally predicted.
 * See docs/adr/0010-grounded-generation-behind-retrieval.md.
 */
export class Retriever {
  readonly #client: BedrockAgentRuntimeClient;
  readonly #knowledgeBaseId: string;
  readonly #scoreThreshold: number;
  readonly #resultCount: number;

  constructor(options: RetrieverOptions) {
    this.#client = options.client;
    this.#knowledgeBaseId = options.knowledgeBaseId;
    this.#scoreThreshold = options.scoreThreshold;
    this.#resultCount = options.resultCount ?? DEFAULT_RESULT_COUNT;
  }

  /**
   * Retrieves passages relevant to a question.
   *
   * When nothing clears the score threshold the result is an explicit `covered: false` rather
   * than an empty success. A caller cannot accidentally render "here is your answer" over an
   * empty array — the type forces the no-coverage case to be handled (requirements.md R20).
   *
   * @param question - The reader's question, in natural language.
   * @returns Citations above the threshold, or an explicit no-coverage outcome.
   *
   * @example
   * ```ts
   * const outcome = await retriever.retrieve('how do I request leave?');
   * if (!outcome.covered) {
   *   // tell the reader plainly; do not synthesise
   * }
   * ```
   */
  async retrieve(question: string): Promise<RetrievalOutcome> {
    const response = await this.#client.send(
      new RetrieveCommand({
        knowledgeBaseId: this.#knowledgeBaseId,
        retrievalQuery: { text: question },
        retrievalConfiguration: {
          vectorSearchConfiguration: { numberOfResults: this.#resultCount },
        },
      }),
    );

    const citations = (response.retrievalResults ?? [])
      .map(toCitation)
      .filter((citation): citation is Citation => citation !== undefined)
      .filter((citation) => citation.score >= this.#scoreThreshold);

    if (citations.length === 0) {
      return { covered: false, reason: 'no-documentation-covers-this' };
    }

    return { covered: true, citations };
  }
}
