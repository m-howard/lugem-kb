import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config';

const VALID_ENV = {
  AWS_REGION: 'us-east-1',
  CORPUS_BUCKET: 'lugem-corpus',
  CORPUS_PREFIX: 'docs/',
  KNOWLEDGE_BASE_ID: 'KB1234567',
  SITE_ROOT: '/app/site',
} as const;

describe('loadConfig', () => {
  it('accepts a complete environment and applies defaults', () => {
    const config = loadConfig({ ...VALID_ENV });

    expect(config).toMatchObject({
      awsRegion: 'us-east-1',
      corpusBucket: 'lugem-corpus',
      knowledgeBaseId: 'KB1234567',
      port: 3000,
      logLevel: 'info',
    });
  });

  it('coerces numeric environment strings', () => {
    const config = loadConfig({ ...VALID_ENV, PORT: '8080', RETRIEVAL_SCORE_THRESHOLD: '0.75' });
    expect(config.port).toBe(8080);
    expect(config.retrievalScoreThreshold).toBe(0.75);
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
