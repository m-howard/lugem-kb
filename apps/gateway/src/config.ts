import { z } from 'zod';

import { AUTH_MODES, type AuthMode } from './auth/verifier';

const DEFAULT_PORT = 3000;
const DEFAULT_LOG_LEVEL = 'info';
const DEFAULT_RETRIEVAL_SCORE_THRESHOLD = 0.4;
const MAX_PORT = 65_535;

/** Four sentences of grounded prose. Enough to answer, short enough that nobody skims past it. */
const DEFAULT_ANSWER_MAX_TOKENS = 700;
const MAX_ANSWER_MAX_TOKENS = 4096;

/** Per client, per minute. A cost guard on an endpoint that bills per question — see rate-limit.ts. */
const DEFAULT_ASK_RATE_LIMIT_PER_MINUTE = 20;
const MAX_ASK_RATE_LIMIT_PER_MINUTE = 10_000;

const DEFAULT_CMS_BRANCH = 'main';
const DEFAULT_CMS_BRANCH_PREFIX = 'cms/';
const DEFAULT_CMS_PATH_PREFIXES = 'docs/';
const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';
const DEFAULT_EMAIL_CLAIM = 'email';
const DEFAULT_NAME_CLAIM = 'name';

const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

const configSchema = z.object({
  port: z.coerce.number().int().positive().max(MAX_PORT).default(DEFAULT_PORT),
  awsRegion: z.string().min(1),
  corpusBucket: z.string().min(1),
  corpusPrefix: z.string().min(1),
  knowledgeBaseId: z.string().min(1),
  siteRoot: z.string().min(1),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default(DEFAULT_LOG_LEVEL),
  retrievalScoreThreshold: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(DEFAULT_RETRIEVAL_SCORE_THRESHOLD),
  // Required, with no default. A model ID names a resource the account must have been granted
  // access to; guessing one would let a task boot, pass /healthz, join the target group, and then
  // fail every question with AccessDeniedException — the exact outcome ADR 0009 exists to avoid.
  answerModelId: z.string().min(1),
  answerMaxTokens: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_ANSWER_MAX_TOKENS)
    .default(DEFAULT_ANSWER_MAX_TOKENS),
  askRateLimitPerMinute: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_ASK_RATE_LIMIT_PER_MINUTE)
    .default(DEFAULT_ASK_RATE_LIMIT_PER_MINUTE),
});

type BaseConfig = z.infer<typeof configSchema>;

/** How identity is established, and which claims carry it — requirements.md R1, Q3 and Q4. */
export type AuthConfig = {
  readonly emailClaim: string;
  readonly nameClaim: string;
} & (
  | { readonly mode: 'bearer'; readonly issuer: string; readonly audience: string }
  | { readonly mode: 'alb'; readonly loadBalancerArn: string }
);

/** Present only when the CMS is switched on. Absent means no editorial routes are mounted at all. */
export interface CmsConfig {
  readonly repository: string;
  readonly defaultBranch: string;
  readonly branchPrefix: string;
  readonly pathPrefixes: readonly string[];
  readonly appId: string;
  readonly installationId: string;
  readonly secretArn: string | undefined;
  readonly privateKeyPath: string | undefined;
  readonly apiBaseUrl: string;
  readonly allowMergeFromCms: boolean;
  readonly auth: AuthConfig;
}

export type Config = BaseConfig & { readonly cms: CmsConfig | undefined };

/**
 * Thrown when the environment cannot produce a valid configuration. Carries the offending
 * variable names so an operator reading a crash loop in CloudWatch learns what to fix from the
 * first line, without correlating against a schema they cannot see.
 */
export class ConfigError extends Error {
  public readonly variables: readonly string[];

  constructor(variables: readonly string[], detail: string) {
    super(`Invalid gateway configuration. Fix ${variables.join(', ')}: ${detail}`);
    this.name = 'ConfigError';
    this.variables = variables;
  }
}

/** Environment variable backing each config field, for error messages operators can act on. */
const ENV_KEYS = {
  port: 'PORT',
  awsRegion: 'AWS_REGION',
  corpusBucket: 'CORPUS_BUCKET',
  corpusPrefix: 'CORPUS_PREFIX',
  knowledgeBaseId: 'KNOWLEDGE_BASE_ID',
  siteRoot: 'SITE_ROOT',
  logLevel: 'LOG_LEVEL',
  retrievalScoreThreshold: 'RETRIEVAL_SCORE_THRESHOLD',
  answerModelId: 'ANSWER_MODEL_ID',
  answerMaxTokens: 'ANSWER_MAX_TOKENS',
  askRateLimitPerMinute: 'ASK_RATE_LIMIT_PER_MINUTE',
} as const satisfies Record<keyof BaseConfig, string>;

const CMS_KEYS = {
  repository: 'CMS_REPOSITORY',
  defaultBranch: 'CMS_DEFAULT_BRANCH',
  branchPrefix: 'CMS_BRANCH_PREFIX',
  pathPrefixes: 'CMS_PATH_PREFIXES',
  appId: 'GITHUB_APP_ID',
  installationId: 'GITHUB_APP_INSTALLATION_ID',
  secretArn: 'CMS_APP_SECRET_ARN',
  privateKeyPath: 'CMS_APP_PRIVATE_KEY_PATH',
  apiBaseUrl: 'GITHUB_API_BASE_URL',
  allowMerge: 'POLICY_ALLOW_MERGE_FROM_CMS',
  authMode: 'AUTH_MODE',
  issuer: 'AUTH_ISSUER_URL',
  audience: 'AUTH_AUDIENCE',
  albArn: 'AUTH_ALB_ARN',
  emailClaim: 'AUTH_EMAIL_CLAIM',
  nameClaim: 'AUTH_NAME_CLAIM',
} as const;

type Env = NodeJS.ProcessEnv;

function read(env: Env, key: string): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function requireAll(env: Env, keys: readonly string[]): void {
  const missing = keys.filter((key) => read(env, key) === undefined);
  if (missing.length > 0) {
    throw new ConfigError(missing, 'required once CMS_REPOSITORY is set');
  }
}

function resolveKeySource(env: Env): Pick<CmsConfig, 'secretArn' | 'privateKeyPath'> {
  const secretArn = read(env, CMS_KEYS.secretArn);
  const privateKeyPath = read(env, CMS_KEYS.privateKeyPath);

  if (secretArn !== undefined && privateKeyPath !== undefined) {
    throw new ConfigError(
      [CMS_KEYS.secretArn, CMS_KEYS.privateKeyPath],
      'name two different private keys. Set exactly one',
    );
  }
  if (secretArn === undefined && privateKeyPath === undefined) {
    throw new ConfigError(
      [CMS_KEYS.secretArn],
      'the GitHub App private key has no source. Set it, or CMS_APP_PRIVATE_KEY_PATH for local development',
    );
  }
  return { secretArn, privateKeyPath };
}

function resolveAuthConfig(env: Env): AuthConfig {
  const mode = read(env, CMS_KEYS.authMode);
  if (mode === undefined || !AUTH_MODES.includes(mode as AuthMode)) {
    throw new ConfigError([CMS_KEYS.authMode], `must be one of: ${AUTH_MODES.join(', ')}`);
  }

  const claims = {
    emailClaim: read(env, CMS_KEYS.emailClaim) ?? DEFAULT_EMAIL_CLAIM,
    nameClaim: read(env, CMS_KEYS.nameClaim) ?? DEFAULT_NAME_CLAIM,
  };

  if (mode === 'alb') {
    requireAll(env, [CMS_KEYS.albArn]);
    return { ...claims, mode: 'alb', loadBalancerArn: read(env, CMS_KEYS.albArn) ?? '' };
  }

  requireAll(env, [CMS_KEYS.issuer, CMS_KEYS.audience]);
  return {
    ...claims,
    mode: 'bearer',
    issuer: read(env, CMS_KEYS.issuer) ?? '',
    audience: read(env, CMS_KEYS.audience) ?? '',
  };
}

function resolveBoolean(env: Env, key: string): boolean {
  const value = read(env, key)?.toLowerCase();
  if (value === undefined || value === 'false') {
    return false;
  }
  if (value === 'true') {
    return true;
  }
  throw new ConfigError([key], 'must be "true" or "false"');
}

/**
 * Reads the CMS block, or returns `undefined` when the CMS is switched off.
 *
 * `CMS_REPOSITORY` is the master switch, mirroring `corpusRepository` in the Pulumi program: unset
 * means the editorial routes are never mounted and none of the companion variables is required.
 * Set, and every companion becomes required — because a gateway that started with half a CMS
 * configuration would pass its health check and then refuse every save with a runtime error, which
 * is the failure ADR 0009 exists to move to start-up.
 */
function resolveCmsConfig(env: Env): CmsConfig | undefined {
  const repository = read(env, CMS_KEYS.repository);
  if (repository === undefined) {
    return undefined;
  }
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new ConfigError([CMS_KEYS.repository], 'must be "owner/name"');
  }

  requireAll(env, [CMS_KEYS.appId, CMS_KEYS.installationId]);

  return {
    repository,
    defaultBranch: read(env, CMS_KEYS.defaultBranch) ?? DEFAULT_CMS_BRANCH,
    branchPrefix: read(env, CMS_KEYS.branchPrefix) ?? DEFAULT_CMS_BRANCH_PREFIX,
    pathPrefixes: (read(env, CMS_KEYS.pathPrefixes) ?? DEFAULT_CMS_PATH_PREFIXES)
      .split(',')
      .map((prefix) => prefix.trim())
      .filter((prefix) => prefix !== ''),
    appId: read(env, CMS_KEYS.appId) ?? '',
    installationId: read(env, CMS_KEYS.installationId) ?? '',
    ...resolveKeySource(env),
    apiBaseUrl: (read(env, CMS_KEYS.apiBaseUrl) ?? DEFAULT_GITHUB_API_BASE_URL).replace(/\/+$/, ''),
    allowMergeFromCms: resolveBoolean(env, CMS_KEYS.allowMerge),
    auth: resolveAuthConfig(env),
  };
}

/**
 * Reads configuration from the environment, or throws.
 *
 * Fail-closed by design (requirements.md R10): a missing variable stops start-up, so a
 * miscredentialed task never becomes healthy and joins the target group. Returning defaults for
 * an absent bucket name would trade a loud boot failure for a quiet permission error later.
 *
 * @param env - Environment to read from. Defaults to `process.env`.
 * @returns The validated configuration.
 * @throws {ConfigError} When any required variable is missing or malformed.
 *
 * @example
 * ```ts
 * const config = loadConfig({ AWS_REGION: 'us-east-1', CORPUS_BUCKET: 'kb', ... });
 * ```
 */
export function loadConfig(env: Env = process.env): Config {
  const result = configSchema.safeParse({
    port: env[ENV_KEYS.port],
    awsRegion: env[ENV_KEYS.awsRegion],
    corpusBucket: env[ENV_KEYS.corpusBucket],
    corpusPrefix: env[ENV_KEYS.corpusPrefix],
    knowledgeBaseId: env[ENV_KEYS.knowledgeBaseId],
    siteRoot: env[ENV_KEYS.siteRoot],
    logLevel: env[ENV_KEYS.logLevel],
    retrievalScoreThreshold: env[ENV_KEYS.retrievalScoreThreshold],
    answerModelId: env[ENV_KEYS.answerModelId],
    answerMaxTokens: env[ENV_KEYS.answerMaxTokens],
    askRateLimitPerMinute: env[ENV_KEYS.askRateLimitPerMinute],
  });

  if (!result.success) {
    const variables = result.error.issues.map((issue) => {
      const field = issue.path[0];
      return typeof field === 'string' && field in ENV_KEYS
        ? ENV_KEYS[field as keyof BaseConfig]
        : String(field);
    });
    const detail = result.error.issues.map((issue) => issue.message).join('; ');

    throw new ConfigError([...new Set(variables)], detail);
  }

  return { ...result.data, cms: resolveCmsConfig(env) };
}
