/** A citation as `POST /v1/ask` returns it. Mirrors `CitationView` in the gateway. */
export interface Citation {
  readonly sourceUri: string;
  readonly path: string | null;
  readonly url: string | null;
  readonly text: string;
  readonly score: number;
  readonly lastReviewed: string | null;
}

export interface ConversationMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export type AnswerStatus = 'streaming' | 'complete' | 'failed';

/**
 * Where an answer is in the "this did not help" flow.
 *
 * `none` is the resting state, not "the reader found it helpful" — nobody clicks to say an answer
 * worked, so the absence of a mark means nothing and is never recorded as though it did.
 */
export type FeedbackStatus = 'none' | 'sending' | 'sent' | 'failed';

/**
 * One entry in the transcript.
 *
 * `not-covered` is its own kind rather than an answer with empty citations, mirroring the API's
 * own choice of a distinct response shape. It is what stops the UI rendering "here is your
 * answer" over nothing, which is the failure requirements.md R20 is written to prevent.
 */
export type Turn =
  | { readonly kind: 'question'; readonly id: string; readonly text: string }
  | {
      readonly kind: 'answer';
      readonly id: string;
      readonly text: string;
      readonly citations: readonly Citation[];
      readonly status: AnswerStatus;
      /**
       * The gateway's handle for this answer, arriving with the citations frame. Empty until then,
       * and the control that reports an unhelpful answer stays hidden while it is — there is
       * nothing to report against yet.
       */
      readonly answerId: string;
      readonly feedback: FeedbackStatus;
    }
  | { readonly kind: 'not-covered'; readonly id: string; readonly message: string }
  /**
   * The reader must sign in first.
   *
   * Only reachable on a deployment that requires reader authentication, which is off by default —
   * see ADR 0016. Its own kind rather than a failure, because it is the one refusal the reader can
   * actually do something about.
   */
  | {
      readonly kind: 'sign-in';
      readonly id: string;
      readonly message: string;
      readonly signInPath: string;
    }
  | { readonly kind: 'failed'; readonly id: string; readonly message: string };
