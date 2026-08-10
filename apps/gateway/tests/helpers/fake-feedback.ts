import { type GapEvent, type GapRecorder } from '../../src/feedback/types';

export interface CollectingRecorder {
  readonly recorder: GapRecorder;
  /** Every event the app recorded, in order. Live — read it after the request resolves. */
  readonly events: GapEvent[];
}

/**
 * A recorder that keeps what it was given.
 *
 * Route tests care which gaps were recorded, not how they marshal into DynamoDB attribute values —
 * `DynamoGapRecorder`'s own unit test covers that against a fake client. Collecting the events
 * keeps the assertions readable and the two concerns apart.
 *
 * @param options - `failWith` makes `record` reject, to prove a route survives a broken recorder.
 * @returns The recorder to pass to `buildTestApp`, and the array it fills.
 *
 * @example
 * ```ts
 * const feedback = collectingRecorder();
 * await buildTestApp({ feedback }).request('/v1/ask', { method: 'POST', body });
 * expect(feedback.events).toHaveLength(1);
 * ```
 */
export function collectingRecorder(options: { failWith?: string } = {}): CollectingRecorder {
  const events: GapEvent[] = [];

  return {
    events,
    recorder: {
      record(event: GapEvent): Promise<void> {
        if (options.failWith !== undefined) {
          return Promise.reject(new Error(options.failWith));
        }
        events.push(event);
        return Promise.resolve();
      },
    },
  };
}
