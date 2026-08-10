import { describe, expect, it } from 'vitest';

import {
  answerModelArns,
  S3_VECTORS_REGIONS,
  StackConfigError,
  validateStackConfig,
} from './config';

const VALID = {
  region: 'us-east-1',
  vpcId: 'vpc-0123456789abcdef0',
  privateSubnetIds: ['subnet-private-a', 'subnet-private-b'],
  publicSubnetIds: ['subnet-public-a'],
  answerModelId: 'anthropic.example-answer-model-v1:0',
} as const;

describe('validateStackConfig', () => {
  it('accepts a minimal valid configuration and applies defaults', () => {
    const config = validateStackConfig({ ...VALID });

    expect(config).toMatchObject({
      region: 'us-east-1',
      vpcId: 'vpc-0123456789abcdef0',
      albScheme: 'internal',
      desiredCount: 1,
      corpusPrefix: 'docs/',
      embeddingModelId: 'amazon.titan-embed-text-v2:0',
      embeddingDimensions: 1024,
      answerMaxTokens: 700,
      askRateLimitPerMinute: 20,
      retrievalScoreThreshold: 0.4,
      gapFeedbackRetentionDays: 90,
    });
  });

  // The stack deploys into an existing VPC and creates none. Without a vpcId there is nothing
  // to deploy into, so this must fail during preview rather than halfway through `up`.
  describe('existing-VPC inputs', () => {
    it.each([
      ['an absent vpcId', { vpcId: undefined }, 'vpcId'],
      ['a blank vpcId', { vpcId: '   ' }, 'vpcId'],
      ['absent private subnets', { privateSubnetIds: undefined }, 'privateSubnetIds'],
      ['empty private subnets', { privateSubnetIds: [] }, 'privateSubnetIds'],
      ['blank-only private subnets', { privateSubnetIds: ['  '] }, 'privateSubnetIds'],
      ['absent public subnets', { publicSubnetIds: undefined }, 'publicSubnetIds'],
      ['empty public subnets', { publicSubnetIds: [] }, 'publicSubnetIds'],
    ])('rejects %s and names the key', (_case, override, key) => {
      expect(() => validateStackConfig({ ...VALID, ...override })).toThrow(StackConfigError);
      try {
        validateStackConfig({ ...VALID, ...override });
        expect.unreachable('validateStackConfig should have thrown');
      } catch (error) {
        expect((error as StackConfigError).keys).toContain(key);
      }
    });

    it('trims whitespace around subnet IDs rather than failing on it', () => {
      const config = validateStackConfig({
        ...VALID,
        privateSubnetIds: [' subnet-a ', 'subnet-b'],
      });
      expect(config.privateSubnetIds).toEqual(['subnet-a', 'subnet-b']);
    });
  });

  // Creating the corpus bucket, IAM roles and ECS service before failing on the vector bucket
  // leaves a half-built stack. Refusing at validation time costs nothing by comparison.
  describe('S3 Vectors region support', () => {
    it.each([...S3_VECTORS_REGIONS])('accepts the supported region %s', (region) => {
      expect(() => validateStackConfig({ ...VALID, region })).not.toThrow();
    });

    it('rejects a region where S3 Vectors is not known to be available', () => {
      expect(() => validateStackConfig({ ...VALID, region: 'sa-east-1' })).toThrow(
        StackConfigError,
      );
    });

    it('names aws:region so the operator knows which key to change', () => {
      try {
        validateStackConfig({ ...VALID, region: 'sa-east-1' });
        expect.unreachable('validateStackConfig should have thrown');
      } catch (error) {
        expect((error as StackConfigError).keys).toContain('aws:region');
        expect((error as StackConfigError).message).toContain('allowUnverifiedRegion');
      }
    });

    it('allows an unverified region behind the documented override', () => {
      const config = validateStackConfig({
        ...VALID,
        region: 'sa-east-1',
        allowUnverifiedRegion: true,
      });
      expect(config.region).toBe('sa-east-1');
    });

    it('rejects an absent region', () => {
      expect(() => validateStackConfig({ ...VALID, region: undefined })).toThrow(StackConfigError);
    });
  });

  // A vector index whose dimension does not match the embedding model fails ingestion rather
  // than degrading, so an unknown model is refused instead of guessed at.
  describe('embedding model', () => {
    it.each([
      ['amazon.titan-embed-text-v2:0', 1024],
      ['amazon.titan-embed-text-v1', 1536],
      ['cohere.embed-english-v3', 1024],
    ])('maps %s to %i dimensions', (embeddingModelId, dimensions) => {
      const config = validateStackConfig({ ...VALID, embeddingModelId });
      expect(config.embeddingDimensions).toBe(dimensions);
    });

    it('refuses a model whose vector dimension is unknown', () => {
      expect(() =>
        validateStackConfig({ ...VALID, embeddingModelId: 'some.new-model-v9' }),
      ).toThrow(StackConfigError);
    });
  });

  describe('albScheme', () => {
    it.each([['internal'], ['internet-facing']])('accepts %s', (albScheme) => {
      expect(validateStackConfig({ ...VALID, albScheme }).albScheme).toBe(albScheme);
    });

    it('rejects anything else', () => {
      expect(() => validateStackConfig({ ...VALID, albScheme: 'public' })).toThrow(
        StackConfigError,
      );
    });
  });

  describe('corpusPrefix', () => {
    it('strips a leading slash', () => {
      expect(validateStackConfig({ ...VALID, corpusPrefix: '/content/' }).corpusPrefix).toBe(
        'content/',
      );
    });

    // A prefix without a trailing slash would let `docs` match `docs-internal/` in the IAM
    // policy and the Bedrock inclusion prefix alike.
    it('requires a trailing slash so the prefix names a directory', () => {
      expect(() => validateStackConfig({ ...VALID, corpusPrefix: 'docs' })).toThrow(
        StackConfigError,
      );
    });
  });

  it('passes through optional overrides', () => {
    const config = validateStackConfig({
      ...VALID,
      desiredCount: 3,
      cpu: 1024,
      memory: 2048,
      logRetentionDays: 90,
      containerPort: 8080,
      certificateArn: 'arn:aws:acm:us-east-1:111122223333:certificate/abc',
    });

    expect(config).toMatchObject({
      desiredCount: 3,
      cpu: 1024,
      memory: 2048,
      logRetentionDays: 90,
      containerPort: 8080,
      certificateArn: 'arn:aws:acm:us-east-1:111122223333:certificate/abc',
    });
  });

  // The answer model is what the task role is granted and what every question is billed against.
  // Getting its ARN shape wrong produces an AccessDenied at the first question, not at preview,
  // so the derivation is resolved here where it can be tested without an AWS account.
  describe('the answer model', () => {
    it('is required, because there is no safe default for a billed resource', () => {
      const { answerModelId: _omitted, ...withoutModel } = VALID;

      expect(() => validateStackConfig(withoutModel)).toThrow(StackConfigError);
      try {
        validateStackConfig(withoutModel);
        expect.unreachable('validateStackConfig should have thrown');
      } catch (error) {
        expect((error as StackConfigError).keys).toContain('answerModelId');
      }
    });

    it('rejects a blank model ID', () => {
      expect(() => validateStackConfig({ ...VALID, answerModelId: '   ' })).toThrow(
        StackConfigError,
      );
    });

    it('treats a plain foundation model as region-local', () => {
      const config = validateStackConfig({ ...VALID });

      expect(config).toMatchObject({
        answerModelIsInferenceProfile: false,
        answerModelBaseId: 'anthropic.example-answer-model-v1:0',
        answerModelRegions: ['us-east-1'],
      });
    });

    // A geo prefix means Bedrock routes the request across regions, and the task policy needs the
    // profile ARN plus the underlying model in each destination — granting only the profile is
    // the single most common cause of an AccessDenied that looks like missing model access.
    it.each([['us.'], ['eu.'], ['apac.']])(
      'recognises the %s prefix as a cross-region inference profile',
      (prefix) => {
        const config = validateStackConfig({
          ...VALID,
          answerModelId: `${prefix}anthropic.example-answer-model-v1:0`,
        });

        expect(config).toMatchObject({
          answerModelIsInferenceProfile: true,
          answerModelBaseId: 'anthropic.example-answer-model-v1:0',
        });
      },
    );

    it('carries every region a profile may route to', () => {
      const config = validateStackConfig({
        ...VALID,
        answerModelId: 'us.anthropic.example-answer-model-v1:0',
        answerModelRegions: ['us-east-1', 'us-west-2'],
      });

      expect(config.answerModelRegions).toEqual(['us-east-1', 'us-west-2']);
    });

    it('rejects an empty region list rather than silently granting nothing', () => {
      expect(() => validateStackConfig({ ...VALID, answerModelRegions: ['  '] })).toThrow(
        StackConfigError,
      );
    });
  });

  describe('answering limits', () => {
    it('accepts explicit values', () => {
      const config = validateStackConfig({
        ...VALID,
        answerMaxTokens: 1200,
        askRateLimitPerMinute: 5,
        retrievalScoreThreshold: 0.65,
        gapFeedbackRetentionDays: 30,
      });

      expect(config).toMatchObject({
        answerMaxTokens: 1200,
        askRateLimitPerMinute: 5,
        retrievalScoreThreshold: 0.65,
        gapFeedbackRetentionDays: 30,
      });
    });

    it.each([
      ['a zero token budget', { answerMaxTokens: 0 }, 'answerMaxTokens'],
      ['a negative token budget', { answerMaxTokens: -1 }, 'answerMaxTokens'],
      ['a fractional token budget', { answerMaxTokens: 1.5 }, 'answerMaxTokens'],
      // A zero limit would refuse every question, which is a silent outage rather than a guard.
      ['a zero rate limit', { askRateLimitPerMinute: 0 }, 'askRateLimitPerMinute'],
      ['a threshold above 1', { retrievalScoreThreshold: 1.5 }, 'retrievalScoreThreshold'],
      ['a negative threshold', { retrievalScoreThreshold: -0.1 }, 'retrievalScoreThreshold'],
      // Q11: a typo here is a retention policy nobody agreed to, in either direction. Zero would
      // expire a reader's question before the weekly report ever read it; a decade would quietly
      // keep it far longer than anyone was told.
      ['a zero retention', { gapFeedbackRetentionDays: 0 }, 'gapFeedbackRetentionDays'],
      ['a negative retention', { gapFeedbackRetentionDays: -1 }, 'gapFeedbackRetentionDays'],
      ['a fractional retention', { gapFeedbackRetentionDays: 30.5 }, 'gapFeedbackRetentionDays'],
      [
        'a retention beyond ten years',
        { gapFeedbackRetentionDays: 3651 },
        'gapFeedbackRetentionDays',
      ],
    ])('rejects %s and names the key', (_case, override, key) => {
      try {
        validateStackConfig({ ...VALID, ...override });
        expect.unreachable('validateStackConfig should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(StackConfigError);
        expect((error as StackConfigError).keys).toContain(key);
      }
    });
  });
});

// The task role is granted exactly what this returns. Getting it wrong produces an AccessDenied
// at the first question rather than at preview, so it is resolved here — where it can be checked
// without an AWS account — instead of inside the component that consumes it.
describe('answerModelArns', () => {
  const ACCOUNT = '111122223333';

  it('names one foundation model for a region-local model', () => {
    const config = validateStackConfig({ ...VALID });

    expect(answerModelArns(config, ACCOUNT)).toEqual([
      'arn:aws:bedrock:us-east-1::foundation-model/anthropic.example-answer-model-v1:0',
    ]);
  });

  it('carries no account ID for a foundation model, because the ARN has no account segment', () => {
    const config = validateStackConfig({ ...VALID });

    expect(answerModelArns(config, ACCOUNT)[0]).not.toContain(ACCOUNT);
  });

  // The failure this guards against: granting the profile alone yields an AccessDenied that names
  // the profile, which sends an operator to the wrong page of the console entirely.
  it('names the profile and every foundation model behind it for an inference profile', () => {
    const config = validateStackConfig({
      ...VALID,
      answerModelId: 'us.anthropic.example-answer-model-v1:0',
      answerModelRegions: ['us-east-1', 'us-west-2'],
    });

    expect(answerModelArns(config, ACCOUNT)).toEqual([
      'arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.anthropic.example-answer-model-v1:0',
      'arn:aws:bedrock:us-east-1::foundation-model/anthropic.example-answer-model-v1:0',
      'arn:aws:bedrock:us-west-2::foundation-model/anthropic.example-answer-model-v1:0',
    ]);
  });

  it('strips the geo prefix from the foundation models, keeping it on the profile', () => {
    const config = validateStackConfig({
      ...VALID,
      answerModelId: 'eu.anthropic.example-answer-model-v1:0',
    });
    const [profile, ...models] = answerModelArns(config, ACCOUNT);

    expect(profile).toContain('inference-profile/eu.anthropic.');
    expect(models.every((arn) => arn.includes('foundation-model/anthropic.'))).toBe(true);
  });

  it('defaults a profile to the stack region when no regions are configured', () => {
    const config = validateStackConfig({
      ...VALID,
      answerModelId: 'us.anthropic.example-answer-model-v1:0',
    });

    expect(answerModelArns(config, ACCOUNT)).toHaveLength(2);
  });

  // No wildcards, in either shape — the property the whole policy rests on.
  it.each([
    ['a foundation model', 'anthropic.example-answer-model-v1:0'],
    ['an inference profile', 'us.anthropic.example-answer-model-v1:0'],
  ])('grants no wildcard for %s', (_case, answerModelId) => {
    const config = validateStackConfig({ ...VALID, answerModelId });

    expect(answerModelArns(config, ACCOUNT).some((arn) => arn.includes('*'))).toBe(false);
  });
});
