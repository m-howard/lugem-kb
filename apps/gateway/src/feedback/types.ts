import { type Logger } from 'pino';

/**
 * What the gap feedback loop records, and — just as importantly — what it does not.
 *
 * Only two things reach storage: a question the corpus could not answer, and an answer a reader
 * marked unhelpful. An answered question is never recorded, in any form. That boundary is the
 * whole of the retention argument in
 * docs/adr/0016-recording-documentation-gaps.md (requirements.md R22, R23, open question Q11).
 */

/**
 * Fields both kinds carry.
 *
 * **No identity, ever.** Not a subject, not an email, not an address — and not conditionally on
 * whether R22 reader authentication happens to be on. Storing the question is what makes a record
 * sensitive; storing who asked it is what makes it attributable to a person, and a gap report needs
 * only the former. Keeping that line absolute is what makes this table defensible.
 */
interface GapEventBase {
  /** Correlates the record with the request that produced it. Minted server-side, never supplied. */
  readonly answerId: string;
  readonly question: string;
}

/**
 * Retrieval returned nothing above the relevance threshold.
 *
 * The near miss is the highest-scoring result that still fell short — the closest the corpus came.
 * It is what lets a report name an owning team rather than filing the question against nobody. The
 * recorder resolves the `s3://` URI to a corpus-relative path before storing it, because a URI is
 * not something a CODEOWNERS pattern can match.
 */
export interface NoCoverageEvent extends GapEventBase {
  readonly kind: 'no-coverage';
  readonly route: '/v1/ask' | '/v1/search';
  readonly nearestSourceUri: string | undefined;
  readonly nearestScore: number | undefined;
}

/**
 * A reader marked an answer unhelpful.
 *
 * The corpus had something to say and said the wrong thing, so the cited pages are the gap, not a
 * near miss. `reason` is optional because requiring an explanation is how you stop people
 * reporting anything at all.
 *
 * `citedPaths` arrive already corpus-relative — they are the `path` field of the citations the
 * reader was shown. They come from the client, which makes them untrusted: the route filters them
 * through `resolveDocumentKey` before they get here, so nothing that does not resolve inside the
 * corpus can reach a report a docs lead reads.
 */
export interface UnhelpfulEvent extends GapEventBase {
  readonly kind: 'unhelpful';
  readonly reason: string | undefined;
  readonly citedPaths: readonly string[];
}

export type GapEvent = NoCoverageEvent | UnhelpfulEvent;

/**
 * What the routes depend on.
 *
 * Narrow on purpose: a route knows it can report a gap and nothing about DynamoDB. It also gives
 * tests something to collect against without standing up a fake AWS client for every route case.
 *
 * `record` resolves either way — see {@link DynamoGapRecorder}, which never rejects.
 */
export interface GapRecorder {
  record(event: GapEvent, logger: Logger): Promise<void>;
}
