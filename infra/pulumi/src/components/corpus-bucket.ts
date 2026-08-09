import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

import { reparentedChild } from './child-options';

const NONCURRENT_VERSION_RETENTION_DAYS = 90;

/**
 * The S3 bucket holding the published markdown corpus — the Bedrock data source.
 *
 * Versioned deliberately: retraction matters here. When a page is unpublished it stops being
 * answerable (requirements.md R21), and versioning is what makes that reversible if the
 * retraction was itself a mistake.
 *
 * @example
 * ```ts
 * const corpus = new CorpusBucket('lugem-kb-dev', { providers: [awsProvider] });
 * ```
 */
export class CorpusBucket extends pulumi.ComponentResource {
  public readonly bucketName: pulumi.Output<string>;
  public readonly bucketArn: pulumi.Output<string>;

  constructor(name: string, opts?: pulumi.ComponentResourceOptions) {
    super('lugem:storage:CorpusBucket', name, {}, opts);

    const bucket = new aws.s3.Bucket(
      `${name}-corpus`,
      { forceDestroy: false, tags: { Component: 'corpus' } },
      reparentedChild(this),
    );

    new aws.s3.BucketVersioning(
      `${name}-corpus-versioning`,
      { bucket: bucket.id, versioningConfiguration: { status: 'Enabled' } },
      reparentedChild(this),
    );

    new aws.s3.BucketServerSideEncryptionConfiguration(
      `${name}-corpus-encryption`,
      {
        bucket: bucket.id,
        rules: [
          {
            applyServerSideEncryptionByDefault: { sseAlgorithm: 'AES256' },
            bucketKeyEnabled: true,
          },
        ],
      },
      reparentedChild(this),
    );

    new aws.s3.BucketPublicAccessBlock(
      `${name}-corpus-public-access-block`,
      {
        bucket: bucket.id,
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      },
      reparentedChild(this),
    );

    new aws.s3.BucketOwnershipControls(
      `${name}-corpus-ownership`,
      { bucket: bucket.id, rule: { objectOwnership: 'BucketOwnerEnforced' } },
      reparentedChild(this),
    );

    new aws.s3.BucketLifecycleConfiguration(
      `${name}-corpus-lifecycle`,
      {
        bucket: bucket.id,
        rules: [
          {
            id: 'expire-noncurrent-versions',
            status: 'Enabled',
            filter: {},
            noncurrentVersionExpiration: { noncurrentDays: NONCURRENT_VERSION_RETENTION_DAYS },
          },
        ],
      },
      reparentedChild(this),
    );

    this.bucketName = bucket.bucket;
    this.bucketArn = bucket.arn;

    this.registerOutputs({ bucketName: this.bucketName, bucketArn: this.bucketArn });
  }
}
