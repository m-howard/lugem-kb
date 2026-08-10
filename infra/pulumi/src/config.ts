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

/**
 * Geo prefixes marking a cross-region inference profile rather than a plain foundation model.
 *
 * The distinction is not cosmetic: a profile needs its own ARN in the task policy *and* the
 * underlying foundation-model ARN in every region it can route to. Granting only the profile
 * produces an AccessDenied naming the profile, which sends an operator to the wrong console page.
 */
const INFERENCE_PROFILE_PREFIXES = ['us.', 'eu.', 'apac.'] as const;

const DEFAULT_EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0';
const DEFAULT_CORPUS_PREFIX = 'docs/';
const DEFAULT_DESIRED_COUNT = 1;
const DEFAULT_CPU = 512;
const DEFAULT_MEMORY = 1024;
const DEFAULT_LOG_RETENTION_DAYS = 30;
const DEFAULT_CONTAINER_PORT = 3000;
const DEFAULT_ANSWER_MAX_TOKENS = 700;
const DEFAULT_ASK_RATE_LIMIT_PER_MINUTE = 20;
const DEFAULT_RETRIEVAL_SCORE_THRESHOLD = 0.4;
const MIN_SCORE = 0;
const MAX_SCORE = 1;

/**
 * How long a recorded question survives before DynamoDB expires it.
 *
 * Ninety days spans a quarter of reports without keeping a reader's words indefinitely. Bounded
 * at ten years because a typo here is a retention policy nobody agreed to — see
 * docs/adr/0015-recording-documentation-gaps.md and requirements.md open question Q11.
 */
const DEFAULT_GAP_FEEDBACK_RETENTION_DAYS = 90;
const MIN_GAP_FEEDBACK_RETENTION_DAYS = 1;
const MAX_GAP_FEEDBACK_RETENTION_DAYS = 3650;

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
  readonly answerModelId?: string | undefined;
  readonly answerModelRegions?: readonly string[] | undefined;
  readonly answerMaxTokens?: number | undefined;
  readonly askRateLimitPerMinute?: number | undefined;
  readonly retrievalScoreThreshold?: number | undefined;
  readonly gapFeedbackRetentionDays?: number | undefined;
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
  /** Bedrock model that writes answers. Required — there is no safe default for a billed resource. */
  readonly answerModelId: string;
  /** True when {@link answerModelId} is a cross-region inference profile rather than a plain model. */
  readonly answerModelIsInferenceProfile: boolean;
  /** {@link answerModelId} with any geo prefix stripped, for building foundation-model ARNs. */
  readonly answerModelBaseId: string;
  /** Regions a cross-region profile may route to. Each needs its own foundation-model ARN granted. */
  readonly answerModelRegions: readonly string[];
  readonly answerMaxTokens: number;
  readonly askRateLimitPerMinute: number;
  readonly retrievalScoreThreshold: number;
  readonly gapFeedbackRetentionDays: number;
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

function requireInRange(value: number, key: string, bounds: readonly [number, number]): number {
  const [low, high] = bounds;
  if (!Number.isFinite(value) || value < low || value > high) {
    return raise(key, `must be between ${String(low)} and ${String(high)}, got ${String(value)}`);
  }
  return value;
}

function requirePositiveInteger(value: number, key: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    return raise(key, `must be a positive whole number, got ${String(value)}`);
  }
  return value;
}

/**
 * Resolves the answer model into everything the task policy needs to name it.
 *
 * Unlike {@link resolveEmbedding} this does not check the ID against a known list. The set of
 * text-generation models is large and changes often, and refusing an unlisted one would mean
 * editing this file every time AWS ships a model. A wrong ID fails loudly at the first question
 * with a ValidationException naming it, which is a good enough signal — whereas a wrong embedding
 * dimension fails ingestion silently, which is why that one is enumerated.
 */
function resolveAnswerModel(
  input: StackConfigInput,
  region: string,
): Pick<
  StackConfig,
  'answerModelId' | 'answerModelIsInferenceProfile' | 'answerModelBaseId' | 'answerModelRegions'
> {
  const answerModelId = requireNonEmpty(input.answerModelId, 'answerModelId');
  const prefix = INFERENCE_PROFILE_PREFIXES.find((candidate) =>
    answerModelId.startsWith(candidate),
  );
  const regions = (input.answerModelRegions ?? [region]).map((id) => id.trim()).filter(Boolean);

  if (regions.length === 0) {
    return raise('answerModelRegions', 'must list at least one region when set');
  }

  return {
    answerModelId,
    answerModelIsInferenceProfile: prefix !== undefined,
    answerModelBaseId: prefix === undefined ? answerModelId : answerModelId.slice(prefix.length),
    answerModelRegions: regions,
  };
}

/**
 * Every ARN the task role must be granted to generate an answer.
 *
 * A plain foundation model is one ARN. A cross-region inference profile is the profile's own ARN
 * *plus* the underlying foundation model in every region the profile can route to — Bedrock
 * authorises against both, and granting only the profile yields an AccessDenied naming the
 * profile, which sends an operator looking in the wrong place entirely.
 *
 * Lives here rather than in the component that consumes it because it is pure, and because this
 * is the shape most likely to be wrong in a way nothing catches until the first question fails in
 * production. Resource wiring is untestable by design (ADR 0008); this is not wiring.
 *
 * Still no wildcards: one model, named regions.
 *
 * @param config - Validated stack configuration, for the model identity and the region.
 * @param accountId - The deploying account, needed only for an inference-profile ARN.
 * @returns The ARNs to name in the policy's `Resource`.
 *
 * @example
 * ```ts
 * answerModelArns({ ...config, answerModelId: 'us.anthropic.x-v1:0' }, '111122223333');
 * // → ['arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.anthropic.x-v1:0',
 * //    'arn:aws:bedrock:us-east-1::foundation-model/anthropic.x-v1:0']
 * ```
 */
export function answerModelArns(config: StackConfig, accountId: string): string[] {
  if (!config.answerModelIsInferenceProfile) {
    return [`arn:aws:bedrock:${config.region}::foundation-model/${config.answerModelId}`];
  }

  return [
    `arn:aws:bedrock:${config.region}:${accountId}:inference-profile/${config.answerModelId}`,
    ...config.answerModelRegions.map(
      (region) => `arn:aws:bedrock:${region}::foundation-model/${config.answerModelBaseId}`,
    ),
  ];
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
    ...resolveAnswerModel(input, region),
    answerMaxTokens: requirePositiveInteger(
      input.answerMaxTokens ?? DEFAULT_ANSWER_MAX_TOKENS,
      'answerMaxTokens',
    ),
    askRateLimitPerMinute: requirePositiveInteger(
      input.askRateLimitPerMinute ?? DEFAULT_ASK_RATE_LIMIT_PER_MINUTE,
      'askRateLimitPerMinute',
    ),
    // Exposed as stack config because it is the gate: below this, no model is called at all.
    // Tuning how readily the assistant declines should not require a code change.
    retrievalScoreThreshold: requireInRange(
      input.retrievalScoreThreshold ?? DEFAULT_RETRIEVAL_SCORE_THRESHOLD,
      'retrievalScoreThreshold',
      [MIN_SCORE, MAX_SCORE],
    ),
    gapFeedbackRetentionDays: requirePositiveInteger(
      requireInRange(
        input.gapFeedbackRetentionDays ?? DEFAULT_GAP_FEEDBACK_RETENTION_DAYS,
        'gapFeedbackRetentionDays',
        [MIN_GAP_FEEDBACK_RETENTION_DAYS, MAX_GAP_FEEDBACK_RETENTION_DAYS],
      ),
      'gapFeedbackRetentionDays',
    ),
  };
}
