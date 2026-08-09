import { describe, expect, it } from 'vitest';

import { S3_VECTORS_REGIONS, StackConfigError, validateStackConfig } from './config';

const VALID = {
  region: 'us-east-1',
  vpcId: 'vpc-0123456789abcdef0',
  privateSubnetIds: ['subnet-private-a', 'subnet-private-b'],
  publicSubnetIds: ['subnet-public-a'],
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
});
