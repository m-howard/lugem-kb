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

/**
 * The best result that did not clear the threshold.
 *
 * A question the corpus does not cover has no citations, which leaves a gap report with nothing to
 * attribute it to. The highest-scoring near miss is the honest approximation of "which part of the
 * documentation should have answered this" — it names an area without claiming to answer anything
 * (requirements.md R23).
 *
 * Absent when retrieval returned no usable result at all, which is a different and less
 * actionable kind of gap.
 */
export interface NearestMiss {
  readonly sourceUri: string;
  readonly score: number;
}

export type RetrievalOutcome =
  | { readonly covered: true; readonly citations: readonly Citation[] }
  | {
      readonly covered: false;
      readonly reason: 'no-documentation-covers-this';
      readonly nearestMiss: NearestMiss | undefined;
    };

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
 * Bedrock returns results in descending score order, but the contract does not promise it and a
 * gap report attributing questions to the wrong page is worse than no attribution. Cheap to be sure.
 */
function toNearestMiss(retrieved: readonly Citation[]): NearestMiss | undefined {
  const best = retrieved.reduce<Citation | undefined>(
    (highest, citation) =>
      highest === undefined || citation.score > highest.score ? citation : highest,
    undefined,
  );

  return best === undefined ? undefined : { sourceUri: best.sourceUri, score: best.score };
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
 * See docs/adr/0012-grounded-generation-behind-retrieval.md.
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
   * The no-coverage outcome carries the highest-scoring result that missed the threshold, where
   * there was one. Nothing renders it — it exists so a gap can be attributed to a documentation
   * area later (requirements.md R23).
   *
   * @param question - The reader's question, in natural language.
   * @returns Citations above the threshold, or an explicit no-coverage outcome with the near miss.
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

    const retrieved = (response.retrievalResults ?? [])
      .map(toCitation)
      .filter((citation): citation is Citation => citation !== undefined);

    const citations = retrieved.filter((citation) => citation.score >= this.#scoreThreshold);

    if (citations.length === 0) {
      return {
        covered: false,
        reason: 'no-documentation-covers-this',
        nearestMiss: toNearestMiss(retrieved),
      };
    }

    return { covered: true, citations };
  }
}
