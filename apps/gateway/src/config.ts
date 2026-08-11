import { z } from 'zod';

import { AUTH_MODES, type AuthMode } from './auth/verifier';
import { checkPathSyntax, normalisePrefix } from './kb/key-policy';

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

/**
 * How long a recorded gap survives. Ninety days is long enough to see a pattern across a quarter's
 * reports and short enough that a question asked once does not sit in a table forever — see
 * docs/adr/0016-recording-documentation-gaps.md and requirements.md open question Q11.
 */
const DEFAULT_GAP_FEEDBACK_RETENTION_DAYS = 90;
const MAX_GAP_FEEDBACK_RETENTION_DAYS = 3650;

const DEFAULT_CMS_BRANCH = 'main';
const DEFAULT_CMS_BRANCH_PREFIX = 'cms/';
const DEFAULT_CMS_PATH_PREFIXES = 'docs/';

/**
 * Where CMS uploads live, and why one level inside `docs/assets/` (requirements.md R15).
 *
 * `apps/docs/docusaurus.config.ts` publishes `docs/assets/` as a static directory, and Docusaurus
 * copies a static directory's *contents* to the site root — so a folder named `media` inside it is
 * served at `/media/`, which is the public path Decap writes into the markdown. See ADR 0021.
 */
const DEFAULT_CMS_MEDIA_FOLDER = 'docs/assets/media/';

/** 2 MiB. Generous for a screenshot or a diagram; small enough that a base64 body stays sane. */
const DEFAULT_CMS_MAX_UPLOAD_BYTES = 2_097_152;
const MAX_CMS_MAX_UPLOAD_BYTES = 26_214_400;

/**
 * How many images one save may carry.
 *
 * Decap sends every image added since the entry was opened in a single `persistEntry`, so this is
 * a bound on one author's editing session rather than on a page. It exists to keep the proxy's
 * request-body limit finite — see {@link proxyBodyLimitBytes}.
 */
export const MAX_ASSETS_PER_SAVE = 8;

/** Room for the markdown, the JSON envelope and base64 padding on top of the images themselves. */
const PROXY_BODY_SLACK_BYTES = 524_288;

/** Base64 spends four characters per three bytes. */
const BASE64_NUMERATOR = 4;
const BASE64_DENOMINATOR = 3;
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
  | {
      readonly mode: 'bearer';
      readonly issuer: string;
      readonly audience: string;
      /**
       * The public OIDC client the `/publisher` page signs in as.
       *
       * Required in `bearer` mode because Decap's proxy backend sends no `Authorization` header of
       * its own — the publisher page has to obtain a token itself, and it cannot start an
       * authorization-code flow without a client id. Public by nature: it travels in the browser's
       * redirect URL either way, which is why `/v1/publisher/config` may serve it anonymously.
       */
      readonly clientId: string;
    }
  | { readonly mode: 'alb'; readonly loadBalancerArn: string }
);

/**
 * Present only when a feedback table is configured. Absent means gaps are not recorded and
 * `/v1/feedback` is never mounted — answering still works, it just produces no demand signal.
 */
export interface FeedbackConfig {
  readonly tableName: string;
  readonly retentionDays: number;
}

/**
 * Present only when a preview bucket is configured (requirements.md R12). Absent means `/previews`
 * is never mounted and the CMS workflow card offers no preview link — the state of every
 * deployment before Phase 3's second half.
 */
export interface PreviewConfig {
  readonly bucket: string;
  /**
   * Absolute base URL the preview surface is reachable at, e.g. `https://kb.internal/previews`.
   *
   * Configured rather than derived from the request. The gateway sits behind a load balancer and
   * cannot trust `Host` to tell it its own public name — and the CMS workflow card needs a link an
   * author can send to a reviewer, not one that only works from the tab it was rendered in.
   */
  readonly baseUrl: string;
}

/**
 * The proxy endpoint's request-body limit, from the per-image limit.
 *
 * A body over this never reaches a handler, so the number has to be derived from the same value the
 * handler enforces rather than picked: an author whose save is dropped by a middleware would
 * otherwise get a different, worse message than one whose image is refused by policy.
 *
 * Base64 costs a third on top of the bytes, and one save may carry
 * {@link MAX_ASSETS_PER_SAVE} images.
 *
 * @param maxUploadBytes - The per-image limit.
 * @returns The request-body limit in bytes.
 *
 * @example
 * ```ts
 * proxyBodyLimitBytes(2_097_152); // → 22_893_397
 * ```
 */
export function proxyBodyLimitBytes(maxUploadBytes: number): number {
  const encoded = Math.ceil((maxUploadBytes * BASE64_NUMERATOR) / BASE64_DENOMINATOR);
  return encoded * MAX_ASSETS_PER_SAVE + PROXY_BODY_SLACK_BYTES;
}

/** Present only when the CMS is switched on. Absent means no editorial routes are mounted at all. */
export interface CmsConfig {
  readonly repository: string;
  readonly defaultBranch: string;
  readonly branchPrefix: string;
  readonly pathPrefixes: readonly string[];
  /** Repository folder authors upload images into — requirements.md R15, ADR 0021. */
  readonly mediaFolder: string;
  /** Largest single upload, in bytes. */
  readonly maxUploadBytes: number;
  readonly appId: string;
  readonly installationId: string;
  readonly secretArn: string | undefined;
  readonly privateKeyPath: string | undefined;
  readonly apiBaseUrl: string;
  readonly allowMergeFromCms: boolean;
}

export type Config = BaseConfig & {
  readonly cms: CmsConfig | undefined;
  readonly feedback: FeedbackConfig | undefined;
  /** Absent when `PREVIEW_BUCKET` is unset: `/previews` is then never mounted. */
  readonly previews: PreviewConfig | undefined;
  /**
   * How identity is established, when anything needs it.
   *
   * Absent means nothing on this deployment authenticates — valid only when the CMS is off and
   * readers are not required to sign in, which `loadConfig` enforces.
   */
  readonly auth: AuthConfig | undefined;
  /**
   * Whether readers must authenticate for `/v1/ask`, `/v1/search` and `/v1/feedback`
   * (requirements.md R22).
   *
   * **Defaults to false**, and that is a decision rather than an oversight. ADR 0013 left
   * `/v1/ask` open because putting a login in front of every reader buys nothing until someone
   * asks for it; ADR 0017 builds the mechanism without making that choice for every deployment.
   */
  readonly readerAuthRequired: boolean;
};

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

const FEEDBACK_KEYS = {
  tableName: 'GAP_FEEDBACK_TABLE',
  retentionDays: 'GAP_FEEDBACK_RETENTION_DAYS',
} as const;

const PREVIEW_KEYS = {
  bucket: 'PREVIEW_BUCKET',
  baseUrl: 'PREVIEW_BASE_URL',
} as const;

const CMS_KEYS = {
  repository: 'CMS_REPOSITORY',
  defaultBranch: 'CMS_DEFAULT_BRANCH',
  branchPrefix: 'CMS_BRANCH_PREFIX',
  pathPrefixes: 'CMS_PATH_PREFIXES',
  mediaFolder: 'CMS_MEDIA_FOLDER',
  maxUploadBytes: 'CMS_MAX_UPLOAD_BYTES',
  appId: 'GITHUB_APP_ID',
  installationId: 'GITHUB_APP_INSTALLATION_ID',
  secretArn: 'CMS_APP_SECRET_ARN',
  privateKeyPath: 'CMS_APP_PRIVATE_KEY_PATH',
  apiBaseUrl: 'GITHUB_API_BASE_URL',
  allowMerge: 'POLICY_ALLOW_MERGE_FROM_CMS',
} as const;

/**
 * Identity, which is no longer only the CMS's concern.
 *
 * These names are unchanged from when they lived in `CMS_KEYS`, so lifting the block out cost no
 * operator anything. `AUTH_MODE` is the master switch: unset means the service can establish no
 * identity at all, which is a valid configuration only when nothing asks it to.
 */
const AUTH_KEYS = {
  authMode: 'AUTH_MODE',
  issuer: 'AUTH_ISSUER_URL',
  audience: 'AUTH_AUDIENCE',
  albArn: 'AUTH_ALB_ARN',
  clientId: 'AUTH_CLIENT_ID',
  emailClaim: 'AUTH_EMAIL_CLAIM',
  nameClaim: 'AUTH_NAME_CLAIM',
  readerAuthRequired: 'READER_AUTH_REQUIRED',
} as const;

type Env = NodeJS.ProcessEnv;

function read(env: Env, key: string): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function requireAll(env: Env, keys: readonly string[], because: string): void {
  const missing = keys.filter((key) => read(env, key) === undefined);
  if (missing.length > 0) {
    throw new ConfigError(missing, because);
  }
}

const BECAUSE_CMS = 'required once CMS_REPOSITORY is set';
const BECAUSE_AUTH = 'required by the configured AUTH_MODE';

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

/**
 * Resolves the media folder, refusing one the CMS could never write to (requirements.md R15).
 *
 * The containment check is the point. A folder outside the write prefixes would let the task boot,
 * pass `/healthz`, join the target group, and then refuse every upload with a path refusal about a
 * folder the author never chose — the failure ADR 0009 exists to move to start-up.
 *
 * @param env - Environment to read from.
 * @param pathPrefixes - The already-resolved write prefixes.
 * @returns The folder, with exactly one trailing slash.
 * @throws {ConfigError} When the folder is malformed or outside every write prefix.
 */
function resolveMediaFolder(env: Env, pathPrefixes: readonly string[]): string {
  const configured = read(env, CMS_KEYS.mediaFolder) ?? DEFAULT_CMS_MEDIA_FOLDER;
  const folder = normalisePrefix(configured);

  if (folder === '') {
    throw new ConfigError(
      [CMS_KEYS.mediaFolder],
      'must name a folder inside the documentation tree. An empty folder would let an upload be ' +
        'written anywhere the CMS may write',
    );
  }

  const syntax = checkPathSyntax(folder.slice(0, -1));
  if (syntax !== undefined) {
    throw new ConfigError(
      [CMS_KEYS.mediaFolder],
      `must be a plain repository folder such as ${DEFAULT_CMS_MEDIA_FOLDER} (${syntax.reason})`,
    );
  }

  const prefixes = pathPrefixes.map(normalisePrefix).filter((prefix) => prefix !== '');
  if (!prefixes.some((prefix) => folder.startsWith(prefix))) {
    throw new ConfigError(
      [CMS_KEYS.mediaFolder, CMS_KEYS.pathPrefixes],
      `disagree: uploads would go to ${folder}, which is outside ${prefixes.join(', ') || '(none configured)'}. ` +
        'Every upload would be refused',
    );
  }

  return folder;
}

function resolveMaxUploadBytes(env: Env): number {
  const raw = read(env, CMS_KEYS.maxUploadBytes);
  if (raw === undefined) {
    return DEFAULT_CMS_MAX_UPLOAD_BYTES;
  }

  const bytes = Number(raw);
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > MAX_CMS_MAX_UPLOAD_BYTES) {
    throw new ConfigError(
      [CMS_KEYS.maxUploadBytes],
      `must be a whole number of bytes between 1 and ${String(MAX_CMS_MAX_UPLOAD_BYTES)}`,
    );
  }

  return bytes;
}

function resolveAuthConfig(env: Env): AuthConfig {
  const mode = read(env, AUTH_KEYS.authMode);
  if (mode === undefined || !AUTH_MODES.includes(mode as AuthMode)) {
    throw new ConfigError([AUTH_KEYS.authMode], `must be one of: ${AUTH_MODES.join(', ')}`);
  }

  const claims = {
    emailClaim: read(env, AUTH_KEYS.emailClaim) ?? DEFAULT_EMAIL_CLAIM,
    nameClaim: read(env, AUTH_KEYS.nameClaim) ?? DEFAULT_NAME_CLAIM,
  };

  if (mode === 'alb') {
    requireAll(env, [AUTH_KEYS.albArn], BECAUSE_AUTH);
    return { ...claims, mode: 'alb', loadBalancerArn: read(env, AUTH_KEYS.albArn) ?? '' };
  }

  requireAll(env, [AUTH_KEYS.issuer, AUTH_KEYS.audience, AUTH_KEYS.clientId], BECAUSE_AUTH);
  return {
    ...claims,
    mode: 'bearer',
    issuer: read(env, AUTH_KEYS.issuer) ?? '',
    audience: read(env, AUTH_KEYS.audience) ?? '',
    clientId: read(env, AUTH_KEYS.clientId) ?? '',
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
 * Reads the gap feedback block, or returns `undefined` when no table is configured.
 *
 * `GAP_FEEDBACK_TABLE` is the master switch, following `CMS_REPOSITORY`. Unset means the recorder
 * is never built and `/v1/feedback` is never mounted, so a deployment that does not want to store
 * reader questions gets that by doing nothing — which is the right default for the one store in
 * this service holding personal data (requirements.md Q11).
 */
function resolveFeedbackConfig(env: Env): FeedbackConfig | undefined {
  const tableName = read(env, FEEDBACK_KEYS.tableName);
  if (tableName === undefined) {
    return undefined;
  }

  const raw = read(env, FEEDBACK_KEYS.retentionDays);
  if (raw === undefined) {
    return { tableName, retentionDays: DEFAULT_GAP_FEEDBACK_RETENTION_DAYS };
  }

  const retentionDays = Number(raw);
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > MAX_GAP_FEEDBACK_RETENTION_DAYS
  ) {
    throw new ConfigError(
      [FEEDBACK_KEYS.retentionDays],
      `must be a whole number of days between 1 and ${String(MAX_GAP_FEEDBACK_RETENTION_DAYS)}`,
    );
  }

  return { tableName, retentionDays };
}

/**
 * Reads the preview block, or returns `undefined` when previews are switched off.
 *
 * `PREVIEW_BUCKET` is the master switch, following `CMS_REPOSITORY` and `GAP_FEEDBACK_TABLE`. Set
 * it and `PREVIEW_BASE_URL` becomes required, because a preview nobody can be sent a link to is
 * not a preview — the CMS workflow card and the pull request comment both need an absolute URL,
 * and a service that boots with half the pair would offer authors a broken link rather than none.
 * ADR 0009: move that failure to start-up.
 */
function resolvePreviewConfig(env: Env): PreviewConfig | undefined {
  const bucket = read(env, PREVIEW_KEYS.bucket);
  if (bucket === undefined) {
    return undefined;
  }

  const baseUrl = read(env, PREVIEW_KEYS.baseUrl);
  if (baseUrl === undefined) {
    throw new ConfigError([PREVIEW_KEYS.baseUrl], `required once ${PREVIEW_KEYS.bucket} is set`);
  }
  if (!/^https?:\/\/\S+$/.test(baseUrl)) {
    throw new ConfigError(
      [PREVIEW_KEYS.baseUrl],
      'must be an absolute http(s) URL, for example https://kb.internal/previews',
    );
  }

  // Stored without a trailing slash so every caller builds `${baseUrl}/pr-42/` the same way.
  return { bucket, baseUrl: baseUrl.replace(/\/+$/, '') };
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

  requireAll(env, [CMS_KEYS.appId, CMS_KEYS.installationId], BECAUSE_CMS);

  const pathPrefixes = (read(env, CMS_KEYS.pathPrefixes) ?? DEFAULT_CMS_PATH_PREFIXES)
    .split(',')
    .map((prefix) => prefix.trim())
    .filter((prefix) => prefix !== '');

  return {
    repository,
    defaultBranch: read(env, CMS_KEYS.defaultBranch) ?? DEFAULT_CMS_BRANCH,
    branchPrefix: read(env, CMS_KEYS.branchPrefix) ?? DEFAULT_CMS_BRANCH_PREFIX,
    pathPrefixes,
    mediaFolder: resolveMediaFolder(env, pathPrefixes),
    maxUploadBytes: resolveMaxUploadBytes(env),
    appId: read(env, CMS_KEYS.appId) ?? '',
    installationId: read(env, CMS_KEYS.installationId) ?? '',
    ...resolveKeySource(env),
    apiBaseUrl: (read(env, CMS_KEYS.apiBaseUrl) ?? DEFAULT_GITHUB_API_BASE_URL).replace(/\/+$/, ''),
    allowMergeFromCms: resolveBoolean(env, CMS_KEYS.allowMerge),
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

  const cms = resolveCmsConfig(env);
  const readerAuthRequired = resolveBoolean(env, AUTH_KEYS.readerAuthRequired);

  // Resolved when either surface needs it, and only then. `READER_AUTH_REQUIRED=true` with no
  // `AUTH_MODE` is therefore a start-up failure naming `AUTH_MODE`, rather than a service that
  // boots believing it authenticates readers and does not — the failure ADR 0009 exists to move
  // to start-up.
  const auth = cms === undefined && !readerAuthRequired ? undefined : resolveAuthConfig(env);

  return {
    ...result.data,
    cms,
    feedback: resolveFeedbackConfig(env),
    previews: resolvePreviewConfig(env),
    auth,
    readerAuthRequired,
  };
}
