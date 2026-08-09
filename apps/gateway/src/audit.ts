import { type Logger } from 'pino';

/**
 * What the gateway decided about a request.
 *
 * A closed set, because an operator aggregating the audit log groups by this field. Free-form
 * strings would make "how many writes did we refuse last week" a question about spelling.
 */
export type AuditDecision = 'allowed' | 'refused' | 'unauthorized' | 'upstream-error' | 'error';

/**
 * One line of the audit log (requirements.md R9).
 *
 * `subject` and `email` are absent only when the request was refused before it was attributed —
 * an unauthenticated call has no author to name.
 */
export interface AuditRecord {
  readonly subject: string | undefined;
  readonly email: string | undefined;
  readonly method: string;
  readonly path: string;
  readonly decision: AuditDecision;
  /** Closed-set refusal reason from the policy that refused, absent when the decision allowed it. */
  readonly reason?: string | undefined;
  /** Status the git host returned, absent when no upstream call was made. */
  readonly upstreamStatus?: number | undefined;
  readonly durationMs: number;
}

/** Decisions that must reach an operator's alarm. Keyed on level, never on message text — R9. */
const WARNING_DECISIONS: readonly AuditDecision[] = ['refused', 'unauthorized'];

/** Something broke rather than being declined. `error` is ours; `upstream-error` is the git host's. */
const ERROR_DECISIONS: readonly AuditDecision[] = ['upstream-error', 'error'];

/**
 * Writes one audit record.
 *
 * Refusals are logged at `warn` and upstream failures at `error`, so an alarm can key on level
 * instead of pattern-matching a message that will drift. Everything else is `info`.
 *
 * Request and response bodies are deliberately absent from the record. The corpus contains HR and
 * finance content, so what an author wrote is more sensitive than the fact that they wrote it —
 * the same stance `routes/ask.ts` takes for question text, for the same reason (requirements.md
 * Q11). Bearer tokens and identity headers are scrubbed separately, by `logging.ts`.
 *
 * @param logger - The request-scoped logger, which already carries `requestId`.
 * @param record - The decision to record.
 *
 * @example
 * ```ts
 * recordAudit(logger, {
 *   subject: 'a1b2', email: 'sam@example.com', method: 'PUT', path: '/v1/cms/drafts/cms/x',
 *   decision: 'refused', reason: 'traversal', durationMs: 3,
 * });
 * ```
 */
export function recordAudit(logger: Logger, record: AuditRecord): void {
  if (ERROR_DECISIONS.includes(record.decision)) {
    logger.error(record, 'gateway request');
    return;
  }
  if (WARNING_DECISIONS.includes(record.decision)) {
    logger.warn(record, 'gateway request');
    return;
  }
  logger.info(record, 'gateway request');
}
