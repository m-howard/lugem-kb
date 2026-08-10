const FEEDBACK_ENDPOINT = '/v1/feedback';
const ACCEPTED = 202;

export interface FeedbackOptions {
  /** The gateway's id for the answer being marked, from the citations frame. */
  readonly answerId: string;
  readonly question: string;
  /** Corpus-relative paths of the citations the reader was shown. */
  readonly citedPaths: readonly string[];
  readonly reason?: string;
  readonly signal?: AbortSignal;
}

/**
 * Tells the gateway an answer did not help.
 *
 * The question and the cited pages travel with the mark because there is no server session and the
 * gateway never stored the answer — so it genuinely cannot look any of it up from the id alone.
 *
 * Never throws, and the caller only learns whether it landed. A reader reporting a bad answer is
 * already having a bad time; the failure worth surfacing is "we did not get that", not a stack of
 * network detail they cannot act on.
 *
 * @param options - The answer being marked, the reader's optional reason, and an abort signal.
 * @returns Whether the gateway accepted the mark.
 */
export async function sendUnhelpfulFeedback(options: FeedbackOptions): Promise<boolean> {
  try {
    const response = await fetch(FEEDBACK_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        answerId: options.answerId,
        question: options.question,
        citedPaths: options.citedPaths,
        ...(options.reason === undefined || options.reason === ''
          ? {}
          : { reason: options.reason }),
      }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    return response.status === ACCEPTED;
  } catch {
    return false;
  }
}
