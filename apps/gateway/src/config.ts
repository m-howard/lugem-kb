import { z } from 'zod';

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

export type Config = z.infer<typeof configSchema>;

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
} as const satisfies Record<keyof Config, string>;

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
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
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

  if (result.success) {
    return result.data;
  }

  const variables = result.error.issues.map((issue) => {
    const field = issue.path[0];
    return typeof field === 'string' && field in ENV_KEYS
      ? ENV_KEYS[field as keyof Config]
      : String(field);
  });
  const detail = result.error.issues.map((issue) => issue.message).join('; ');

  throw new ConfigError([...new Set(variables)], detail);
}
