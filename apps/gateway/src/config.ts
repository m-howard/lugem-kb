import { z } from 'zod';

const DEFAULT_PORT = 3000;
const DEFAULT_LOG_LEVEL = 'info';
const DEFAULT_RETRIEVAL_SCORE_THRESHOLD = 0.4;
const MAX_PORT = 65_535;

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
