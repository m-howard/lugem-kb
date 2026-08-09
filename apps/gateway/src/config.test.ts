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

  describe('the CMS block', () => {
    const CMS_ENV = {
      CMS_REPOSITORY: 'acme/handbook',
      GITHUB_APP_ID: '123456',
      GITHUB_APP_INSTALLATION_ID: '78901234',
      CMS_APP_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:111122223333:secret:cms-abc',
      AUTH_MODE: 'bearer',
      AUTH_ISSUER_URL: 'https://idp.example.com/realm',
      AUTH_AUDIENCE: 'lugem-cms',
    } as const;

    // CMS_REPOSITORY is the master switch, mirroring `corpusRepository` in the Pulumi program.
    // Unset means no editorial routes are mounted and nothing else is required — which is what
    // keeps every existing deployment working unchanged.
    it('is absent when CMS_REPOSITORY is unset', () => {
      expect(loadConfig({ ...VALID_ENV }).cms).toBeUndefined();
    });

    it('is absent when CMS_REPOSITORY is blank', () => {
      expect(loadConfig({ ...VALID_ENV, CMS_REPOSITORY: '  ' }).cms).toBeUndefined();
    });

    it('applies defaults for everything that is only tuning', () => {
      expect(loadConfig({ ...VALID_ENV, ...CMS_ENV }).cms).toMatchObject({
        repository: 'acme/handbook',
        defaultBranch: 'main',
        branchPrefix: 'cms/',
        pathPrefixes: ['docs/'],
        apiBaseUrl: 'https://api.github.com',
        allowMergeFromCms: false,
        auth: { mode: 'bearer', emailClaim: 'email', nameClaim: 'name' },
      });
    });

    it('splits several path prefixes and drops blank entries', () => {
      const config = loadConfig({
        ...VALID_ENV,
        ...CMS_ENV,
        CMS_PATH_PREFIXES: 'docs/, handbook/ ,,',
      });

      expect(config.cms?.pathPrefixes).toEqual(['docs/', 'handbook/']);
    });

    it('trims a trailing slash from the API base URL, so paths do not double up', () => {
      const config = loadConfig({ ...VALID_ENV, ...CMS_ENV, GITHUB_API_BASE_URL: 'https://ghe.acme.com/api/v3/' });

      expect(config.cms?.apiBaseUrl).toBe('https://ghe.acme.com/api/v3');
    });

    // R10 again, for the half of the configuration that did not exist before. Switching the CMS on
    // with half its settings would let a task boot, pass /healthz and then fail the first save.
    describe('fails closed', () => {
      it.each([
        ['GITHUB_APP_ID'],
        ['GITHUB_APP_INSTALLATION_ID'],
        ['AUTH_MODE'],
        ['AUTH_ISSUER_URL'],
        ['AUTH_AUDIENCE'],
      ])('rejects a missing %s and names it', (variable) => {
        const env = {
          ...VALID_ENV,
          ...Object.fromEntries(Object.entries(CMS_ENV).filter(([key]) => key !== variable)),
        };

        expect(() => loadConfig(env)).toThrow(ConfigError);
        try {
          loadConfig(env);
          expect.unreachable('loadConfig should have thrown');
        } catch (error) {
          expect((error as ConfigError).variables).toContain(variable);
        }
      });

      it('names both app ids at once when neither is set', () => {
        const { GITHUB_APP_ID: _id, GITHUB_APP_INSTALLATION_ID: _installation, ...rest } = CMS_ENV;

        try {
          loadConfig({ ...VALID_ENV, ...rest });
          expect.unreachable('loadConfig should have thrown');
        } catch (error) {
          expect((error as ConfigError).variables).toEqual([
            'GITHUB_APP_ID',
            'GITHUB_APP_INSTALLATION_ID',
          ]);
        }
      });

      it.each([
        ['a repository that is not owner/name', { CMS_REPOSITORY: 'handbook' }],
        ['a repository with a trailing path', { CMS_REPOSITORY: 'acme/handbook/docs' }],
        ['an unknown auth mode', { AUTH_MODE: 'basic' }],
        ['a non-boolean merge policy', { POLICY_ALLOW_MERGE_FROM_CMS: 'yes' }],
      ])('rejects %s', (_case, override) => {
        expect(() => loadConfig({ ...VALID_ENV, ...CMS_ENV, ...override })).toThrow(ConfigError);
      });

      // R2: the private key comes from a secret store. The local file path exists for development
      // only, and having both set means nobody can tell which key is in use.
      it('rejects two private key sources', () => {
        expect(() =>
          loadConfig({ ...VALID_ENV, ...CMS_ENV, CMS_APP_PRIVATE_KEY_PATH: '/tmp/cms.pem' }),
        ).toThrow(/exactly one/);
      });

      it('rejects no private key source at all', () => {
        const { CMS_APP_SECRET_ARN: _arn, ...rest } = CMS_ENV;

        expect(() => loadConfig({ ...VALID_ENV, ...rest })).toThrow(/CMS_APP_SECRET_ARN/);
      });
    });

    describe('auth modes', () => {
      it('reads the issuer and audience in bearer mode', () => {
        expect(loadConfig({ ...VALID_ENV, ...CMS_ENV }).cms?.auth).toEqual({
          mode: 'bearer',
          issuer: 'https://idp.example.com/realm',
          audience: 'lugem-cms',
          emailClaim: 'email',
          nameClaim: 'name',
        });
      });

      it('reads the load balancer ARN in alb mode', () => {
        const { AUTH_ISSUER_URL: _issuer, AUTH_AUDIENCE: _audience, ...rest } = CMS_ENV;
        const config = loadConfig({
          ...VALID_ENV,
          ...rest,
          AUTH_MODE: 'alb',
          AUTH_ALB_ARN: 'arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/l/1',
        });

        expect(config.cms?.auth).toMatchObject({
          mode: 'alb',
          loadBalancerArn: 'arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/l/1',
        });
      });

      it('requires the load balancer ARN in alb mode', () => {
        expect(() => loadConfig({ ...VALID_ENV, ...CMS_ENV, AUTH_MODE: 'alb' })).toThrow(
          /AUTH_ALB_ARN/,
        );
      });

      // requirements.md Q4: several providers do not put email in the access token under that
      // name. Making the claim configurable is how the answer to Q4 becomes a config change.
      it('takes the claim names from configuration', () => {
        const config = loadConfig({
          ...VALID_ENV,
          ...CMS_ENV,
          AUTH_EMAIL_CLAIM: 'upn',
          AUTH_NAME_CLAIM: 'given_name',
        });

        expect(config.cms?.auth).toMatchObject({ emailClaim: 'upn', nameClaim: 'given_name' });
      });
    });
  });
});
