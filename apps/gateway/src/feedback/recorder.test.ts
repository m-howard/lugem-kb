import { type DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import pino, { type Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DynamoGapRecorder } from './recorder';
import { type GapEvent } from './types';

const TABLE = 'gap-feedback';
const RETENTION_DAYS = 90;
const SECONDS_PER_DAY = 86_400;
const LOCATION = { bucket: 'corpus', prefix: 'docs/' };

/** A fixed clock, so the day partition and the TTL are exact rather than approximately right. */
const NOW = new Date('2026-08-10T14:30:00.000Z');

const NO_COVERAGE: GapEvent = {
  kind: 'no-coverage',
  route: '/v1/ask',
  answerId: 'answer-1',
  question: 'how do I request unpaid leave?',
  nearestSourceUri: 's3://corpus/docs/people/leave.md',
  nearestScore: 0.31,
};

const UNHELPFUL: GapEvent = {
  kind: 'unhelpful',
  answerId: 'answer-2',
  question: 'how much notice do I give?',
  reason: 'It quoted the wrong policy.',
  citedPaths: ['people/leave.md', 'people/notice.md'],
};

function build(options: { failWith?: string } = {}): {
  recorder: DynamoGapRecorder;
  send: ReturnType<typeof vi.fn>;
  logger: Logger;
  logs: Record<string, unknown>[];
} {
  const send = vi.fn((command: unknown) => {
    if (!(command instanceof PutItemCommand)) {
      return Promise.reject(new Error('unexpected command'));
    }
    return options.failWith === undefined
      ? Promise.resolve({})
      : Promise.reject(new Error(options.failWith));
  });

  const logs: Record<string, unknown>[] = [];
  const logger = pino(
    { level: 'warn' },
    {
      write: (line: string) => {
        logs.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );

  return {
    send,
    logger,
    logs,
    recorder: new DynamoGapRecorder({
      client: { send } as unknown as DynamoDBClient,
      tableName: TABLE,
      retentionDays: RETENTION_DAYS,
      location: LOCATION,
    }),
  };
}

function itemFrom(send: ReturnType<typeof vi.fn>): Record<string, { S?: string; N?: string }> {
  const command = send.mock.calls[0]?.[0] as PutItemCommand;
  return command.input.Item as Record<string, { S?: string; N?: string }>;
}

describe('DynamoGapRecorder', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('partitions by UTC day and sorts by time, so the report can query a date range', async () => {
    const { recorder, send, logger } = build();

    await recorder.record(NO_COVERAGE, logger);

    const item = itemFrom(send);
    expect(item['day']?.S).toBe('2026-08-10');
    expect(item['recordedAt']?.S).toBe('2026-08-10T14:30:00.000Z#answer-1');
  });

  // Q11: retention is not a policy document somebody has to remember to enforce — it is an
  // attribute on every item, and DynamoDB deletes on it. Ninety days out, to the second.
  it('sets a TTL the configured number of days out', async () => {
    const { recorder, send, logger } = build();

    await recorder.record(NO_COVERAGE, logger);

    const expiresAt = Number(itemFrom(send)['expiresAt']?.N);
    expect(expiresAt).toBe(Math.floor(NOW.getTime() / 1000) + RETENTION_DAYS * SECONDS_PER_DAY);
  });

  // A CODEOWNERS pattern matches paths, not `s3://` URIs, so the URI is resolved on the way in
  // rather than leaving every reader of the table to work out the corpus layout.
  it('resolves the near miss to a corpus path so the gap can be attributed to an area', async () => {
    const { recorder, send, logger } = build();

    await recorder.record(NO_COVERAGE, logger);

    const item = itemFrom(send);
    expect(item['kind']?.S).toBe('no-coverage');
    expect(item['question']?.S).toBe('how do I request unpaid leave?');
    expect(item['nearestPath']?.S).toBe('people/leave.md');
    expect(item['nearestScore']?.N).toBe('0.31');
  });

  it('drops a near miss pointing outside the corpus rather than storing a guess', async () => {
    const { recorder, send, logger } = build();

    await recorder.record(
      { ...NO_COVERAGE, nearestSourceUri: 's3://somewhere-else/notes/scratch.md' },
      logger,
    );

    expect(itemFrom(send)).not.toHaveProperty('nearestPath');
  });

  it('records the cited pages and reason for an unhelpful mark', async () => {
    const { recorder, send, logger } = build();

    await recorder.record(UNHELPFUL, logger);

    const item = itemFrom(send) as unknown as Record<string, { S?: string; L?: { S: string }[] }>;
    expect(item['kind']?.S).toBe('unhelpful');
    expect(item['reason']?.S).toBe('It quoted the wrong policy.');
    expect(item['citedPaths']?.L?.map((entry) => entry.S)).toEqual([
      'people/leave.md',
      'people/notice.md',
    ]);
  });

  // Q11. The line this class must never cross: a question is sensitive, a question plus the person
  // who asked it is a personnel record. Nothing here should ever be able to produce one.
  it.each([['subject'], ['email'], ['name'], ['ip'], ['clientAddress']])(
    'never writes a %s attribute, for either kind of event',
    async (attribute) => {
      const { recorder, send, logger } = build();

      await recorder.record(NO_COVERAGE, logger);
      await recorder.record(UNHELPFUL, logger);

      for (const call of send.mock.calls) {
        expect((call[0] as PutItemCommand).input.Item).not.toHaveProperty(attribute);
      }
    },
  );

  it.each([
    ['nearest source', { ...NO_COVERAGE, nearestSourceUri: undefined }, 'nearestPath'],
    ['nearest score', { ...NO_COVERAGE, nearestScore: undefined }, 'nearestScore'],
    ['reason', { ...UNHELPFUL, reason: undefined }, 'reason'],
  ])('omits the attribute entirely for an absent %s', async (_case, event, attribute) => {
    const { recorder, send, logger } = build();

    await recorder.record(event, logger);

    expect(itemFrom(send)).not.toHaveProperty(attribute);
  });

  it('records which route produced a no-coverage gap', async () => {
    const { recorder, send, logger } = build();

    await recorder.record({ ...NO_COVERAGE, route: '/v1/search' }, logger);

    expect(itemFrom(send)['route']?.S).toBe('/v1/search');
  });

  // The point of the whole class. A gap is a nice-to-have; the reader's answer is not.
  it('swallows a write failure and warns, rather than failing the reader request', async () => {
    const { recorder, send, logger, logs } = build({ failWith: 'ProvisionedThroughputExceeded' });

    await expect(recorder.record(NO_COVERAGE, logger)).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ err: 'ProvisionedThroughputExceeded', kind: 'no-coverage' });
  });

  it('writes to the configured table', async () => {
    const { recorder, send, logger } = build();

    await recorder.record(NO_COVERAGE, logger);

    expect((send.mock.calls[0]?.[0] as PutItemCommand).input.TableName).toBe(TABLE);
  });
});
