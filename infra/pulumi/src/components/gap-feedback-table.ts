import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

export interface GapFeedbackTableArgs {
  /** Mirrored onto the table so an operator can read the retention policy off the resource. */
  readonly retentionDays: number;
}

/**
 * The table holding documentation gaps — questions the corpus could not answer, and answers a
 * reader marked unhelpful (requirements.md R23).
 *
 * **Keys.** `day` (UTC calendar day) partitions, `recordedAt` sorts within it. The only query this
 * table ever serves is the report's "everything in the last N days", which becomes N bounded
 * `Query` calls on known partitions — no `Scan`, no secondary index. A single partition would have
 * concentrated every write on one key and grown without limit.
 *
 * **Retention is enforced here, not by a policy someone remembers.** Every item carries an
 * `expiresAt` epoch-seconds attribute and DynamoDB deletes on it. That is the mechanism behind the
 * answer to open question Q11 — see docs/adr/0016-recording-documentation-gaps.md.
 *
 * **Point-in-time recovery is off, and that is the load-bearing part of this file.** PITR keeps a
 * continuous 35-day backup that TTL deletion cannot reach, so switching it on would quietly extend
 * retention past what readers were told. The same goes for on-demand backups. This is the one
 * table in the stack where a backup is a liability rather than an insurance policy.
 *
 * Billed per request: it is idle most of the time and read once a week. Provisioned capacity would
 * be a standing monthly charge for nothing.
 *
 * @example
 * ```ts
 * const gaps = new GapFeedbackTable('lugem-kb-dev', { retentionDays: 90 }, { provider });
 * ```
 */
export class GapFeedbackTable extends pulumi.ComponentResource {
  public readonly tableName: pulumi.Output<string>;
  public readonly tableArn: pulumi.Output<string>;

  constructor(name: string, args: GapFeedbackTableArgs, opts?: pulumi.ComponentResourceOptions) {
    super('lugem:storage:GapFeedbackTable', name, {}, opts);

    const table = new aws.dynamodb.Table(
      `${name}-gap-feedback`,
      {
        billingMode: 'PAY_PER_REQUEST',
        hashKey: 'day',
        rangeKey: 'recordedAt',
        // Only the key attributes are declared. DynamoDB is schemaless for the rest, and the item
        // shape lives with the code that writes it in `apps/gateway/src/feedback/recorder.ts`.
        attributes: [
          { name: 'day', type: 'S' },
          { name: 'recordedAt', type: 'S' },
        ],
        ttl: { attributeName: 'expiresAt', enabled: true },
        // AWS-managed key rather than the DynamoDB-owned default, so key use for the one store
        // holding reader questions appears in CloudTrail.
        serverSideEncryption: { enabled: true },
        pointInTimeRecovery: { enabled: false },
        deletionProtectionEnabled: true,
        tags: { Component: 'gap-feedback', RetentionDays: String(args.retentionDays) },
      },
      { parent: this },
    );

    this.tableName = table.name;
    this.tableArn = table.arn;

    this.registerOutputs({ tableName: this.tableName, tableArn: this.tableArn });
  }
}
