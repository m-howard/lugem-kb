/**
 * Thrown when a request is refused by path or branch policy (requirements.md R3, R4).
 *
 * Carries the closed-set reason so the route can answer 403 with it and the audit record can be
 * aggregated by it, exactly as `DocumentPolicyError` already does for corpus reads.
 */
export class CmsPolicyError extends Error {
  public readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'CmsPolicyError';
    this.reason = reason;
  }
}

/**
 * Thrown when an upload is over the configured size limit (requirements.md R15).
 *
 * Its own class rather than a {@link CmsPolicyError} because the two deserve different answers. A
 * policy refusal is 403 — "you may not do that" — while an oversized image is 413: the author is
 * entitled to add images, and this one is simply too big. An operator reading the audit log should
 * be able to tell "authors keep hitting the limit, consider raising it" from "somebody is trying to
 * write outside the documentation", and one status covering both would hide that.
 */
export class MediaTooLargeError extends Error {
  public readonly reason = 'media-too-large';

  constructor(message: string) {
    super(message);
    this.name = 'MediaTooLargeError';
  }
}

/**
 * Thrown when an entry is not under editorial workflow — it has no draft branch, or its draft has
 * already been published.
 *
 * Distinct from a refusal, and distinct from a missing document: the editor asks about entries it
 * last saw, and "that draft is finished" is a normal answer to give an author whose colleague
 * merged it. Decap turns the 404 this becomes into its own `EditorialWorkflowError`, which is what
 * makes the card disappear from the board rather than showing an error.
 */
export class DraftMissingError extends Error {
  constructor(contentKey: string) {
    super(`No draft is in progress for "${contentKey}".`);
    this.name = 'DraftMissingError';
  }
}

/**
 * Thrown when an editor asks for an operation this gateway does not offer.
 *
 * Answered as a bad request rather than a refusal, and the distinction is worth keeping: a refusal
 * means the author asked for something they may not have, while this means they asked for
 * something nobody here can have. Aggregating the two together would make a missing feature look
 * like an access problem in the audit log.
 */
export class UnsupportedActionError extends Error {
  public readonly action: string;

  constructor(action: string, message: string) {
    super(message);
    this.name = 'UnsupportedActionError';
    this.action = action;
  }
}
