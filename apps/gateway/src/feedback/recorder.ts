import { type AttributeValue, type DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { type Logger } from 'pino';

import { type GapEvent, type GapRecorder } from './types';
import { type CorpusLocation, resolveSourceUrl } from '../kb/source-url';

const SECONDS_PER_DAY = 86_400;
const MS_PER_SECOND = 1000;
const DATE_LENGTH = 'YYYY-MM-DD'.length;

export interface DynamoGapRecorderOptions {
  readonly client: DynamoDBClient;
  readonly tableName: string;
  /** How long a recorded question survives before DynamoDB expires it — requirements.md Q11. */
  readonly retentionDays: number;
  /** Where the corpus lives, so a near miss can be stored as a path rather than an `s3://` URI. */
  readonly location: CorpusLocation;
}

function text(value: string): AttributeValue {
  return { S: value };
}

/**
 * Writes documentation gaps to DynamoDB so they can be reported on a cadence.
 *
 * **Partitioned by UTC day.** The only query this store ever serves is the report's "everything in
 * the last N days", which becomes N bounded `Query` calls — no `Scan`, no secondary index. A single
 * partition would have concentrated every write on one key and grown without limit; a day bounds
 * both, and TTL then expires items in place.
 *
 * **Recording never fails a request.** `record` catches everything and logs a warning. A reader
 * asking a question the corpus cannot answer is already having a bad time; a throttled table must
 * not also cost them their answer. The consequence is that gaps are best-effort and the report is a
 * lower bound, which is the right trade for a demand signal.
 *
 * What reaches this class is bounded by its callers, and that boundary is the retention argument:
 * only unanswered questions and explicit unhelpful marks. See
 * docs/adr/0016-recording-documentation-gaps.md.
 */
export class DynamoGapRecorder implements GapRecorder {
  readonly #client: DynamoDBClient;
  readonly #tableName: string;
  readonly #retentionDays: number;
  readonly #location: CorpusLocation;

  constructor(options: DynamoGapRecorderOptions) {
    this.#client = options.client;
    this.#tableName = options.tableName;
    this.#retentionDays = options.retentionDays;
    this.#location = options.location;
  }

  /**
   * Attributes that differ by kind.
   *
   * Optional values are omitted entirely rather than written as nulls, so an absent near miss stays
   * distinguishable from one nobody has read yet. A URI outside the corpus resolves to nothing and
   * is dropped rather than stored as a guess, matching how citations are rendered unlinked.
   */
  #detailsOf(event: GapEvent): Record<string, AttributeValue> {
    if (event.kind === 'unhelpful') {
      return {
        ...(event.reason === undefined ? {} : { reason: text(event.reason) }),
        citedPaths: { L: event.citedPaths.map((path) => text(path)) },
      };
    }

    const route = { route: text(event.route) };

    const nearestPath =
      event.nearestSourceUri === undefined
        ? undefined
        : resolveSourceUrl(event.nearestSourceUri, this.#location)?.path;

    return {
      ...route,
      ...(nearestPath === undefined ? {} : { nearestPath: text(nearestPath) }),
      ...(event.nearestScore === undefined
        ? {}
        : { nearestScore: { N: String(event.nearestScore) } }),
    };
  }

  /**
   * Records one gap, or gives up quietly.
   *
   * @param event - The unanswered question or unhelpful mark to store.
   * @param logger - Request logger, used only if the write fails.
   *
   * @example
   * ```ts
   * await recorder.record(
   *   { kind: 'no-coverage', route: '/v1/ask', answerId, question, nearestSourceUri, nearestScore },
   *   c.get('logger'),
   * );
   * ```
   */
  async record(event: GapEvent, logger: Logger): Promise<void> {
    const now = new Date();
    const recordedAt = now.toISOString();

    try {
      await this.#client.send(
        new PutItemCommand({
          TableName: this.#tableName,
          Item: {
            day: text(recordedAt.slice(0, DATE_LENGTH)),
            recordedAt: text(`${recordedAt}#${event.answerId}`),
            kind: text(event.kind),
            answerId: text(event.answerId),
            question: text(event.question),
            ...this.#detailsOf(event),
            expiresAt: {
              N: String(
                Math.floor(now.getTime() / MS_PER_SECOND) + this.#retentionDays * SECONDS_PER_DAY,
              ),
            },
          },
        }),
      );
    } catch (error) {
      // Deliberately swallowed. See the class docblock: a feedback table that is throttled, missing
      // or misconfigured must not turn into a failed answer.
      logger.warn(
        { err: error instanceof Error ? error.message : String(error), kind: event.kind },
        'could not record a documentation gap',
      );
    }
  }
}
