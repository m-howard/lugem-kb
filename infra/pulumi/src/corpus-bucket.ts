import * as aws from '@pulumi/aws';

import type * as pulumi from '@pulumi/pulumi';

const NONCURRENT_VERSION_RETENTION_DAYS = 90;

export interface CorpusBucket {
  readonly bucket: aws.s3.Bucket;
  readonly name: pulumi.Output<string>;
  readonly arn: pulumi.Output<string>;
}

/**
 * The S3 bucket holding the published markdown corpus — the Bedrock data source.
 *
 * Versioned deliberately: retraction matters here. When a page is unpublished it stops being
 * answerable (requirements.md R21), and versioning is what makes that reversible if the
 * retraction was itself a mistake.
 *
 * @param name - Resource name prefix.
 * @returns The bucket and its identifiers.
 */
export function createCorpusBucket(name: string): CorpusBucket {
  const bucket = new aws.s3.Bucket(`${name}-corpus`, {
    forceDestroy: false,
    tags: { Component: 'corpus' },
  });

  new aws.s3.BucketVersioning(`${name}-corpus-versioning`, {
    bucket: bucket.id,
    versioningConfiguration: { status: 'Enabled' },
  });

  new aws.s3.BucketServerSideEncryptionConfiguration(`${name}-corpus-encryption`, {
    bucket: bucket.id,
    rules: [
      {
        applyServerSideEncryptionByDefault: { sseAlgorithm: 'AES256' },
        bucketKeyEnabled: true,
      },
    ],
  });

  new aws.s3.BucketPublicAccessBlock(`${name}-corpus-public-access-block`, {
    bucket: bucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
  });

  new aws.s3.BucketOwnershipControls(`${name}-corpus-ownership`, {
    bucket: bucket.id,
    rule: { objectOwnership: 'BucketOwnerEnforced' },
  });

  new aws.s3.BucketLifecycleConfiguration(`${name}-corpus-lifecycle`, {
    bucket: bucket.id,
    rules: [
      {
        id: 'expire-noncurrent-versions',
        status: 'Enabled',
        filter: {},
        noncurrentVersionExpiration: { noncurrentDays: NONCURRENT_VERSION_RETENTION_DAYS },
      },
    ],
  });

  return { bucket, name: bucket.bucket, arn: bucket.arn };
}
