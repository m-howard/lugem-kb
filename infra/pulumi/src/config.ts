/**
 * Regions where S3 Vectors was available when this list was last checked (2026-08).
 *
 * S3 Vectors reached general availability in a narrower set of regions than S3 itself, and the
 * failure mode when you get it wrong is ugly: `pulumi up` creates the corpus bucket, the IAM
 * roles and the ECS service, then fails on the vector bucket, leaving a half-built stack. Failing
 * during `preview` costs nothing by comparison.
 *
 * AWS adds regions faster than this constant will be updated, so
 * {@link StackConfigInput.allowUnverifiedRegion} exists as a documented override rather than
 * forcing a fork. Verify against:
 * https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors-regions-quotas.html
 */
export const S3_VECTORS_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-2',
  'eu-central-1',
  'eu-west-1',
  'ap-southeast-2',
  'ap-northeast-1',
] as const;

/** Titan Embed Text v2 emits 1024-dimension vectors; the index must match exactly or ingestion fails. */
export const EMBEDDING_DIMENSIONS: Readonly<Record<string, number>> = {
  'amazon.titan-embed-text-v2:0': 1024,
  'amazon.titan-embed-text-v1': 1536,
  'cohere.embed-english-v3': 1024,
  'cohere.embed-multilingual-v3': 1024,
};

const DEFAULT_EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0';
const DEFAULT_CORPUS_PREFIX = 'docs/';
const DEFAULT_DESIRED_COUNT = 1;
const DEFAULT_CPU = 512;
const DEFAULT_MEMORY = 1024;
const DEFAULT_LOG_RETENTION_DAYS = 30;
const DEFAULT_CONTAINER_PORT = 3000;

/** Raw, unvalidated values as they arrive from `pulumi.Config`. */
export interface StackConfigInput {
  readonly region?: string | undefined;
  readonly vpcId?: string | undefined;
  readonly privateSubnetIds?: readonly string[] | undefined;
  readonly publicSubnetIds?: readonly string[] | undefined;
  readonly albScheme?: string | undefined;
  readonly certificateArn?: string | undefined;
  readonly desiredCount?: number | undefined;
  readonly cpu?: number | undefined;
  readonly memory?: number | undefined;
  readonly logRetentionDays?: number | undefined;
  readonly embeddingModelId?: string | undefined;
  readonly corpusPrefix?: string | undefined;
  readonly containerPort?: number | undefined;
  readonly allowUnverifiedRegion?: boolean | undefined;
}

export interface StackConfig {
  readonly region: string;
  readonly vpcId: string;
  readonly privateSubnetIds: readonly string[];
  readonly publicSubnetIds: readonly string[];
  readonly albScheme: 'internal' | 'internet-facing';
  readonly certificateArn: string | undefined;
  readonly desiredCount: number;
  readonly cpu: number;
  readonly memory: number;
  readonly logRetentionDays: number;
  readonly embeddingModelId: string;
  readonly embeddingDimensions: number;
  readonly corpusPrefix: string;
  readonly containerPort: number;
}

/**
 * Thrown when stack configuration cannot produce a deployable stack.
 *
 * Named keys, not a generic message: an operator running `pulumi preview` in CI sees exactly
 * which `pulumi config set` command to run.
 */
export class StackConfigError extends Error {
  public readonly keys: readonly string[];

  constructor(keys: readonly string[], detail: string) {
    super(`Invalid stack configuration (${keys.join(', ')}): ${detail}`);
    this.name = 'StackConfigError';
    this.keys = keys;
  }
}

function requireNonEmpty(value: string | undefined, key: string): string {
  if (value === undefined || value.trim() === '') {
    return raise(key, 'is required');
  }
  return value.trim();
}

function requireSubnets(value: readonly string[] | undefined, key: string): readonly string[] {
  const subnets = (value ?? []).map((id) => id.trim()).filter((id) => id !== '');
  if (subnets.length === 0) {
    return raise(key, 'must list at least one subnet ID');
  }
  return subnets;
}

function raise(key: string, detail: string): never {
  throw new StackConfigError([key], detail);
}

function resolveAlbScheme(value: string | undefined): 'internal' | 'internet-facing' {
  const scheme = value ?? 'internal';
  if (scheme !== 'internal' && scheme !== 'internet-facing') {
    return raise('albScheme', `must be "internal" or "internet-facing", got "${scheme}"`);
  }
  return scheme;
}

function resolveEmbedding(modelId: string): number {
  const dimensions = EMBEDDING_DIMENSIONS[modelId];
  if (dimensions === undefined) {
    return raise(
      'embeddingModelId',
      `unknown embedding model "${modelId}". Add its vector dimension to EMBEDDING_DIMENSIONS ` +
        `before using it — a mismatched index silently fails ingestion. Known: ${Object.keys(EMBEDDING_DIMENSIONS).join(', ')}`,
    );
  }
  return dimensions;
}

function assertRegionSupportsS3Vectors(region: string, allowUnverified: boolean): void {
  if (allowUnverified) {
    return;
  }
  if (!S3_VECTORS_REGIONS.includes(region as (typeof S3_VECTORS_REGIONS)[number])) {
    raise(
      'aws:region',
      `S3 Vectors is not known to be available in "${region}". Verified regions: ` +
        `${S3_VECTORS_REGIONS.join(', ')}. If AWS has since added this region, set ` +
        `allowUnverifiedRegion to true.`,
    );
  }
}

/**
 * Validates raw stack configuration, or throws.
 *
 * Pure and I/O-free so the whole rule set is unit-testable without a Pulumi engine, credentials,
 * or a network. Everything that can be caught before the first AWS call is caught here.
 *
 * @param input - Raw values read from `pulumi.Config`.
 * @returns Validated configuration with defaults applied.
 * @throws {StackConfigError} When a required key is missing or a value is unusable.
 *
 * @example
 * ```ts
 * validateStackConfig({ region: 'us-east-1', vpcId: 'vpc-123', privateSubnetIds: ['subnet-a'], publicSubnetIds: ['subnet-b'] });
 * ```
 */
export function validateStackConfig(input: StackConfigInput): StackConfig {
  const region = requireNonEmpty(input.region, 'aws:region');
  assertRegionSupportsS3Vectors(region, input.allowUnverifiedRegion ?? false);

  const embeddingModelId = input.embeddingModelId ?? DEFAULT_EMBEDDING_MODEL;
  const corpusPrefix = (input.corpusPrefix ?? DEFAULT_CORPUS_PREFIX).replace(/^\/+/, '');

  if (!corpusPrefix.endsWith('/')) {
    raise('corpusPrefix', 'must end with "/" so it names a directory, not a key prefix fragment');
  }

  return {
    region,
    vpcId: requireNonEmpty(input.vpcId, 'vpcId'),
    privateSubnetIds: requireSubnets(input.privateSubnetIds, 'privateSubnetIds'),
    publicSubnetIds: requireSubnets(input.publicSubnetIds, 'publicSubnetIds'),
    albScheme: resolveAlbScheme(input.albScheme),
    certificateArn: input.certificateArn,
    desiredCount: input.desiredCount ?? DEFAULT_DESIRED_COUNT,
    cpu: input.cpu ?? DEFAULT_CPU,
    memory: input.memory ?? DEFAULT_MEMORY,
    logRetentionDays: input.logRetentionDays ?? DEFAULT_LOG_RETENTION_DAYS,
    embeddingModelId,
    embeddingDimensions: resolveEmbedding(embeddingModelId),
    corpusPrefix,
    containerPort: input.containerPort ?? DEFAULT_CONTAINER_PORT,
  };
}
