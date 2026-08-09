import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config';

const VALID_ENV = {
  AWS_REGION: 'us-east-1',
  CORPUS_BUCKET: 'lugem-corpus',
  CORPUS_PREFIX: 'docs/',
  KNOWLEDGE_BASE_ID: 'KB1234567',
  SITE_ROOT: '/app/site',
  ANSWER_MODEL_ID: 'anthropic.example-answer-model-v1:0',
} as const;

describe('loadConfig', () => {
  it('accepts a complete environment and applies defaults', () => {
    const config = loadConfig({ ...VALID_ENV });

    expect(config).toMatchObject({
      awsRegion: 'us-east-1',
      corpusBucket: 'lugem-corpus',
      knowledgeBaseId: 'KB1234567',
      answerModelId: 'anthropic.example-answer-model-v1:0',
      port: 3000,
      logLevel: 'info',
      answerMaxTokens: 700,
      askRateLimitPerMinute: 20,
    });
  });

  it('coerces numeric environment strings', () => {
    const config = loadConfig({
      ...VALID_ENV,
      PORT: '8080',
      RETRIEVAL_SCORE_THRESHOLD: '0.75',
      ANSWER_MAX_TOKENS: '1200',
      ASK_RATE_LIMIT_PER_MINUTE: '5',
    });
    expect(config.port).toBe(8080);
    expect(config.retrievalScoreThreshold).toBe(0.75);
    expect(config.answerMaxTokens).toBe(1200);
    expect(config.askRateLimitPerMinute).toBe(5);
  });

  // R10: a missing variable must stop start-up. Defaulting `CORPUS_BUCKET` to something would
  // trade a loud boot failure for an AccessDenied on the first request an hour later.
  describe('fails closed', () => {
    it.each([
      ['AWS_REGION'],
      ['CORPUS_BUCKET'],
      ['CORPUS_PREFIX'],
      ['KNOWLEDGE_BASE_ID'],
      ['SITE_ROOT'],
      // No default. Guessing a model ID would let the task boot, pass /healthz, join the target
      // group, and then fail every question with AccessDeniedException.
      ['ANSWER_MODEL_ID'],
    ])('rejects a missing %s and names it', (variable) => {
      const env = Object.fromEntries(Object.entries(VALID_ENV).filter(([key]) => key !== variable));

      expect(() => loadConfig(env)).toThrow(ConfigError);
      try {
        loadConfig(env);
        expect.unreachable('loadConfig should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).variables).toContain(variable);
        expect((error as ConfigError).message).toContain(variable);
      }
    });

    it('rejects an empty string as firmly as an absent variable', () => {
      expect(() => loadConfig({ ...VALID_ENV, CORPUS_BUCKET: '' })).toThrow(ConfigError);
    });

    it('names every offending variable at once, not just the first', () => {
      try {
        loadConfig({ SITE_ROOT: '/app/site' });
        expect.unreachable('loadConfig should have thrown');
      } catch (error) {
        const { variables } = error as ConfigError;
        expect(variables).toEqual(
          expect.arrayContaining([
            'AWS_REGION',
            'CORPUS_BUCKET',
            'CORPUS_PREFIX',
            'KNOWLEDGE_BASE_ID',
            'ANSWER_MODEL_ID',
          ]),
        );
      }
    });

    it.each([
      ['a non-numeric port', { PORT: 'eighty' }],
      ['a port above the valid range', { PORT: '70000' }],
      ['a negative port', { PORT: '-1' }],
      ['an unknown log level', { LOG_LEVEL: 'chatty' }],
      ['a threshold above 1', { RETRIEVAL_SCORE_THRESHOLD: '1.5' }],
      ['a negative threshold', { RETRIEVAL_SCORE_THRESHOLD: '-0.2' }],
      ['an empty answer model ID', { ANSWER_MODEL_ID: '' }],
      ['a fractional answer token budget', { ANSWER_MAX_TOKENS: '700.5' }],
      ['a zero answer token budget', { ANSWER_MAX_TOKENS: '0' }],
      ['an answer token budget above the cap', { ANSWER_MAX_TOKENS: '100000' }],
      ['a zero rate limit, which would refuse every question', { ASK_RATE_LIMIT_PER_MINUTE: '0' }],
      ['a negative rate limit', { ASK_RATE_LIMIT_PER_MINUTE: '-5' }],
    ])('rejects %s', (_case, override) => {
      expect(() => loadConfig({ ...VALID_ENV, ...override })).toThrow(ConfigError);
    });
  });

  it('carries the schema detail in the message so the fix is obvious from a log line', () => {
    try {
      loadConfig({ ...VALID_ENV, LOG_LEVEL: 'chatty' });
      expect.unreachable('loadConfig should have thrown');
    } catch (error) {
      expect((error as ConfigError).message).toMatch(/LOG_LEVEL/);
    }
  });
});
