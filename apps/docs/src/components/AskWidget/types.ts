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
    }
  | { readonly kind: 'not-covered'; readonly id: string; readonly message: string }
  | { readonly kind: 'failed'; readonly id: string; readonly message: string };
