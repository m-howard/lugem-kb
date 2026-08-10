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
      AUTH_CLIENT_ID: 'lugem-cms-admin',
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

    it("resolves auth alongside it, now that auth is not the CMS's alone", () => {
      expect(loadConfig({ ...VALID_ENV, ...CMS_ENV }).auth).toMatchObject({
        mode: 'bearer',
        emailClaim: 'email',
        nameClaim: 'name',
      });
    });

    it('applies defaults for everything that is only tuning', () => {
      expect(loadConfig({ ...VALID_ENV, ...CMS_ENV }).cms).toMatchObject({
        repository: 'acme/handbook',
        defaultBranch: 'main',
        branchPrefix: 'cms/',
        pathPrefixes: ['docs/'],
        apiBaseUrl: 'https://api.github.com',
        allowMergeFromCms: false,
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
      const config = loadConfig({
        ...VALID_ENV,
        ...CMS_ENV,
        GITHUB_API_BASE_URL: 'https://ghe.acme.com/api/v3/',
      });

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
        // Without it the `/admin` page cannot start a sign-in, and the failure would surface as an
        // editor that loads and then cannot authenticate — long after the deploy looked healthy.
        ['AUTH_CLIENT_ID'],
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
      it('reads the issuer, audience and admin client id in bearer mode', () => {
        expect(loadConfig({ ...VALID_ENV, ...CMS_ENV }).auth).toEqual({
          mode: 'bearer',
          issuer: 'https://idp.example.com/realm',
          audience: 'lugem-cms',
          clientId: 'lugem-cms-admin',
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

        expect(config.auth).toMatchObject({
          mode: 'alb',
          loadBalancerArn:
            'arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/l/1',
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

        expect(config.auth).toMatchObject({ emailClaim: 'upn', nameClaim: 'given_name' });
      });
    });
  });

  // R22, built and switched off (ADR 0017). The switch is what decides whether readers meet a
  // login, so its default and its fail-closed behaviour are the whole of the test.
  describe('reader authentication', () => {
    it('is off unless asked for, so no reader meets a login by accident', () => {
      const config = loadConfig({ ...VALID_ENV });

      expect(config.readerAuthRequired).toBe(false);
      expect(config.auth).toBeUndefined();
    });

    it('resolves auth when readers must sign in, with no CMS configured at all', () => {
      const config = loadConfig({
        ...VALID_ENV,
        READER_AUTH_REQUIRED: 'true',
        AUTH_MODE: 'bearer',
        AUTH_ISSUER_URL: 'https://idp.example.com/realm',
        AUTH_AUDIENCE: 'lugem-readers',
        AUTH_CLIENT_ID: 'lugem-readers-app',
      });

      expect(config.readerAuthRequired).toBe(true);
      expect(config.auth).toMatchObject({ mode: 'bearer', audience: 'lugem-readers' });
      expect(config.cms).toBeUndefined();
    });

    // ADR 0009: a service that boots believing it authenticates readers, and does not, is the
    // exact failure fail-closed configuration exists to prevent.
    it('refuses to start when readers must sign in but no mode is configured', () => {
      const env = { ...VALID_ENV, READER_AUTH_REQUIRED: 'true' };

      expect(() => loadConfig(env)).toThrow(ConfigError);
      try {
        loadConfig(env);
      } catch (error) {
        expect((error as ConfigError).variables).toContain('AUTH_MODE');
      }
    });

    it.each([['1'], ['yes'], ['TRUE ']])('refuses %s rather than reading it as false', (value) => {
      expect(() => loadConfig({ ...VALID_ENV, READER_AUTH_REQUIRED: value })).toThrow(ConfigError);
    });
  });

  // R23 needs somewhere to put a gap; Q11 says that somewhere must have a retention policy. The
  // table name is the master switch, so a deployment that does not want to hold reader questions
  // gets that by doing nothing.
  describe('gap feedback', () => {
    it('is absent when no table is configured', () => {
      expect(loadConfig({ ...VALID_ENV }).feedback).toBeUndefined();
    });

    it('defaults retention to ninety days', () => {
      const config = loadConfig({ ...VALID_ENV, GAP_FEEDBACK_TABLE: 'gaps' });

      expect(config.feedback).toEqual({ tableName: 'gaps', retentionDays: 90 });
    });

    it('takes retention from configuration', () => {
      const config = loadConfig({
        ...VALID_ENV,
        GAP_FEEDBACK_TABLE: 'gaps',
        GAP_FEEDBACK_RETENTION_DAYS: '30',
      });

      expect(config.feedback?.retentionDays).toBe(30);
    });

    it.each([
      ['zero', '0'],
      ['negative', '-1'],
      ['fractional', '1.5'],
      ['not a number', 'ninety'],
      ['beyond ten years', '3651'],
    ])('rejects a %s retention and names the variable', (_case, value) => {
      const env = { ...VALID_ENV, GAP_FEEDBACK_TABLE: 'gaps', GAP_FEEDBACK_RETENTION_DAYS: value };

      expect(() => loadConfig(env)).toThrow(ConfigError);
      try {
        loadConfig(env);
      } catch (error) {
        expect((error as ConfigError).variables).toContain('GAP_FEEDBACK_RETENTION_DAYS');
      }
    });
  });

  // requirements.md R12. `PREVIEW_BUCKET` is the master switch, following the CMS and gap blocks.
  describe('pull request previews', () => {
    it('is absent when no preview bucket is configured', () => {
      expect(loadConfig({ ...VALID_ENV }).previews).toBeUndefined();
    });

    it('reads the bucket and the base URL', () => {
      const config = loadConfig({
        ...VALID_ENV,
        PREVIEW_BUCKET: 'lugem-previews',
        PREVIEW_BASE_URL: 'https://kb.internal/previews',
      });

      expect(config.previews).toEqual({
        bucket: 'lugem-previews',
        baseUrl: 'https://kb.internal/previews',
      });
    });

    // Every caller builds `${baseUrl}/pr-42/`, so the trailing slash is normalised away once here
    // rather than guarded against in each of them.
    it('drops a trailing slash from the base URL', () => {
      const config = loadConfig({
        ...VALID_ENV,
        PREVIEW_BUCKET: 'lugem-previews',
        PREVIEW_BASE_URL: 'https://kb.internal/previews/',
      });

      expect(config.previews?.baseUrl).toBe('https://kb.internal/previews');
    });

    // A bucket with no base URL would boot, serve previews, and offer authors no link to one —
    // exactly the half-configured state ADR 0009 moves to start-up.
    it('refuses a bucket with no base URL, naming the variable', () => {
      const env = { ...VALID_ENV, PREVIEW_BUCKET: 'lugem-previews' };

      expect(() => loadConfig(env)).toThrow(ConfigError);
      try {
        loadConfig(env);
      } catch (error) {
        expect((error as ConfigError).variables).toEqual(['PREVIEW_BASE_URL']);
      }
    });

    it.each([
      ['relative', '/previews'],
      ['schemeless', 'kb.internal/previews'],
      ['not a URL at all', 'yes please'],
    ])('refuses a %s base URL', (_case, value) => {
      const env = { ...VALID_ENV, PREVIEW_BUCKET: 'lugem-previews', PREVIEW_BASE_URL: value };

      expect(() => loadConfig(env)).toThrow(ConfigError);
    });

    it('does not require a base URL when previews are off', () => {
      expect(() =>
        loadConfig({ ...VALID_ENV, PREVIEW_BASE_URL: 'https://kb.internal/previews' }),
      ).not.toThrow();
    });
  });
});
