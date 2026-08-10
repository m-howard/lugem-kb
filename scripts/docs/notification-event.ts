import { type NotificationKind } from './notification-message';

/** The fields this feature reads from a webhook payload. Everything else is ignored. */
export interface PullRequestEvent {
  readonly action?: string | undefined;
  readonly pull_request?:
    | {
        readonly number?: number | undefined;
        readonly title?: string | undefined;
        readonly html_url?: string | undefined;
        readonly body?: string | null | undefined;
        readonly draft?: boolean | undefined;
        readonly merged?: boolean | undefined;
        readonly head?: { readonly ref?: string | undefined } | undefined;
      }
    | undefined;
  readonly review?: { readonly state?: string | undefined } | undefined;
}

const REVIEW_REQUESTING_ACTIONS = new Set(['opened', 'reopened', 'ready_for_review']);

/**
 * Decides which of R14's three moments a webhook payload is, if any.
 *
 * Most deliveries are none of them — a label added, a synchronise push, a review that approved.
 * Returning `undefined` for those is the common path, not an error case.
 *
 * A draft pull request never asks for review. GitHub sends `opened` for one all the same, and
 * notifying on it would mail an owner about a change the author has not finished writing.
 *
 * @param eventName - The webhook event, e.g. `pull_request_target`.
 * @param payload - The delivered payload.
 * @returns The notification to send, or `undefined` when this delivery asks for nothing.
 *
 * @example
 * ```ts
 * classifyEvent('pull_request_target', { action: 'closed', pull_request: { merged: true } });
 * // → 'published'
 * ```
 */
export function classifyEvent(
  eventName: string,
  payload: PullRequestEvent,
): NotificationKind | undefined {
  const pull = payload.pull_request;
  if (pull === undefined) {
    return undefined;
  }

  if (eventName === 'pull_request_review') {
    return payload.action === 'submitted' && payload.review?.state === 'changes_requested'
      ? 'changes-requested'
      : undefined;
  }

  if (eventName !== 'pull_request' && eventName !== 'pull_request_target') {
    return undefined;
  }

  if (payload.action === 'closed') {
    return pull.merged === true ? 'published' : undefined;
  }

  if (payload.action !== undefined && REVIEW_REQUESTING_ACTIONS.has(payload.action)) {
    return pull.draft === true ? undefined : 'review-requested';
  }

  return undefined;
}
