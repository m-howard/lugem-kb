import { StackConfigError } from './config';

/** Owner is alphanumeric with internal hyphens; a repository name also allows dot and underscore. */
const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

/** GitHub app and installation ids are integers, and pasting the app *slug* instead is the usual slip. */
const NUMERIC_ID_PATTERN = /^\d+$/;

const OIDC_PROVIDER_ARN_MARKER = ':oidc-provider/';

const DEFAULT_BRANCH = 'main';

const CMS_APP_KEYS = ['cmsGitHubAppId', 'cmsGitHubAppInstallationId'] as const;

/** How the gateway is told who is calling — requirements.md R1; ADR 0013. */
export const CMS_AUTH_MODES = ['bearer', 'alb'] as const;

export type CmsAuthMode = (typeof CMS_AUTH_MODES)[number];

const DEFAULT_CMS_BRANCH_PREFIX = 'cms/';
const DEFAULT_CMS_PATH_PREFIXES: readonly string[] = ['docs/'];

/**
 * Where CMS uploads live — requirements.md R15.
 *
 * Must match `DEFAULT_CMS_MEDIA_FOLDER` in `apps/gateway/src/config.ts` and the static directory
 * `apps/docs/docusaurus.config.ts` publishes, or images are stored somewhere the site does not serve
 * from. See [ADR 0021](../../../docs/adr/0021-images-travel-with-the-draft.md).
 */
const DEFAULT_CMS_MEDIA_FOLDER = 'docs/assets/media/';

/** 2 MiB, matching the gateway's own default. */
const DEFAULT_CMS_MAX_UPLOAD_BYTES = 2_097_152;
const MAX_CMS_MAX_UPLOAD_BYTES = 26_214_400;

/**
 * The endpoints `authenticate-oidc` needs. AWS rejects a partial block, so all of them or none.
 *
 * `cmsOidcClientSecret` is deliberately absent: it is read as a Pulumi secret in the composition
 * root and never passes through this module, so a plaintext credential cannot end up in a config
 * object that gets logged, serialised or asserted on in a test.
 */
const OIDC_LISTENER_KEYS = [
  'cmsOidcIssuer',
  'cmsOidcAuthorizationEndpoint',
  'cmsOidcTokenEndpoint',
  'cmsOidcUserInfoEndpoint',
  'cmsOidcClientId',
] as const;

/**
 * Checks that run on every pull request, and are therefore safe to require for merge.
 *
 * The three `Infrastructure` checks are deliberately absent. That workflow is `paths`-filtered to
 * `infra/**`, so requiring its checks would leave every documentation-only pull request waiting
 * forever on a job that will never be scheduled. `Analyze (javascript-typescript)` and
 * `Analyze (actions)` are omitted for a softer version of the same reason: CodeQL only runs for
 * pull requests targeting the default branch.
 */
export const DEFAULT_REQUIRED_STATUS_CHECKS: readonly string[] = [
  'Lint',
  'Typecheck',
  'Test',
  'Build',
  'Playwright',
];

/** Raw, unvalidated values as they arrive from `pulumi.Config`. */
export interface GithubConfigInput {
  readonly corpusRepository?: string | undefined;
  readonly corpusRepositoryDescription?: string | undefined;
  readonly corpusDefaultBranch?: string | undefined;
  readonly corpusRepositoryCreate?: boolean | undefined;
  readonly corpusRepositoryImportId?: string | undefined;
  readonly requiredStatusChecks?: readonly string[] | undefined;
  readonly githubOidcProviderArn?: string | undefined;
  readonly cmsGitHubAppId?: string | undefined;
  readonly cmsGitHubAppInstallationId?: string | undefined;
  readonly cmsAuthMode?: string | undefined;
  readonly cmsAuthIssuerUrl?: string | undefined;
  readonly cmsAuthAudience?: string | undefined;
  readonly cmsAuthClientId?: string | undefined;
  readonly cmsAuthEmailClaim?: string | undefined;
  readonly cmsAuthNameClaim?: string | undefined;
  readonly cmsBranchPrefix?: string | undefined;
  readonly cmsPathPrefixes?: readonly string[] | undefined;
  readonly cmsMediaFolder?: string | undefined;
  readonly cmsMaxUploadBytes?: number | undefined;
  readonly cmsAllowMerge?: boolean | undefined;
  readonly cmsOidcIssuer?: string | undefined;
  readonly cmsOidcAuthorizationEndpoint?: string | undefined;
  readonly cmsOidcTokenEndpoint?: string | undefined;
  readonly cmsOidcUserInfoEndpoint?: string | undefined;
  readonly cmsOidcClientId?: string | undefined;
  /**
   * Read from the AWS half of the configuration, not a key of its own.
   *
   * It is here because `cmsAuthMode: alb` is unusable without HTTPS, and that cross-cutting rule
   * belongs with the other pure validation rather than in the composition root where no test can
   * reach it.
   */
  readonly certificateArn?: string | undefined;
  /**
   * Whether readers must authenticate — requirements.md R22, ADR 0017.
   *
   * Also read from the AWS half, and here for the same reason `certificateArn` is: reader
   * authentication currently reuses the identity provider the editorial surface configures, so
   * "you cannot require it without one" is a cross-cutting rule that belongs with the other pure
   * validation rather than in the composition root where no test can reach it.
   */
  readonly readerAuthRequired?: boolean | undefined;
}

/** The GitHub App the gateway authenticates as — requirements.md R2. */
export interface CmsAppConfig {
  readonly appId: string;
  readonly installationId: string;
}

/**
 * What an ALB running `authenticate-oidc` needs to reach the identity provider.
 *
 * The client secret is not here — see {@link OIDC_LISTENER_KEYS}.
 */
export interface CmsOidcListenerConfig {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly userInfoEndpoint: string;
  readonly clientId: string;
}

/** How the gateway establishes identity, and what the CMS may touch — R1, R3, R4, R7. */
export interface CmsGatewayConfig {
  readonly authMode: CmsAuthMode;
  readonly issuerUrl: string | undefined;
  readonly audience: string | undefined;
  /**
   * The public OIDC client the `/publisher` editor signs in as. Present only in `bearer` mode; in
   * `alb` mode the load balancer runs the exchange with its own client and secret.
   */
  readonly clientId: string | undefined;
  readonly emailClaim: string | undefined;
  readonly nameClaim: string | undefined;
  readonly branchPrefix: string;
  readonly pathPrefixes: readonly string[];
  /** Folder authors upload images into — requirements.md R15. Always inside `pathPrefixes`. */
  readonly mediaFolder: string;
  /** Largest single upload, in bytes. */
  readonly maxUploadBytes: number;
  readonly allowMerge: boolean;
  /** Present only in `alb` mode, where the load balancer runs the OIDC exchange. */
  readonly oidcListener: CmsOidcListenerConfig | undefined;
}

export interface GithubConfig {
  readonly owner: string;
  readonly repository: string;
  readonly fullName: string;
  /**
   * GitHub clears a description the repository resource does not declare, so adopting a repository
   * without setting this empties the description that is there today.
   */
  readonly description: string | undefined;
  readonly defaultBranch: string;
  /** True when this stack owns the repository resource itself, by creating or adopting it. */
  readonly manageRepositoryResource: boolean;
  readonly createRepository: boolean;
  readonly importId: string | undefined;
  readonly requiredStatusChecks: readonly string[];
  readonly oidcProviderArn: string | undefined;
  readonly cmsApp: CmsAppConfig | undefined;
  /** Present exactly when `cmsApp` is: the gateway can do nothing editorial without the App. */
  readonly cmsGateway: CmsGatewayConfig | undefined;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? undefined : trimmed;
}

function resolveDefaultBranch(value: string | undefined): string {
  const branch = emptyToUndefined(value) ?? DEFAULT_BRANCH;
  if (branch.startsWith('refs/')) {
    throw new StackConfigError(
      ['corpusDefaultBranch'],
      `must be a branch name such as "main", not a fully qualified ref, got "${branch}"`,
    );
  }
  return branch;
}

/**
 * An explicitly empty list is honoured: it means "protect the branch but require no checks".
 * A list containing a blank entry is a typo, not an intention.
 */
function resolveStatusChecks(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined) {
    return DEFAULT_REQUIRED_STATUS_CHECKS;
  }

  const checks = value.map((check) => check.trim());
  if (checks.some((check) => check === '')) {
    throw new StackConfigError(
      ['requiredStatusChecks'],
      'must not contain empty check names. Each entry is the job name GitHub reports, such as "Lint"',
    );
  }
  return checks;
}

function resolveOidcProviderArn(value: string | undefined): string | undefined {
  const arn = emptyToUndefined(value);
  if (arn === undefined) {
    return undefined;
  }

  if (!arn.startsWith('arn:') || !arn.includes(OIDC_PROVIDER_ARN_MARKER)) {
    throw new StackConfigError(
      ['githubOidcProviderArn'],
      `must be an IAM OIDC provider ARN containing "${OIDC_PROVIDER_ARN_MARKER}", got "${arn}". ` +
        'Leave it unset to have this stack create the provider.',
    );
  }
  return arn;
}

function resolveCmsApp(input: GithubConfigInput): CmsAppConfig | undefined {
  const appId = emptyToUndefined(input.cmsGitHubAppId);
  const installationId = emptyToUndefined(input.cmsGitHubAppInstallationId);

  if (appId === undefined && installationId === undefined) {
    return undefined;
  }
  if (appId === undefined || installationId === undefined) {
    throw new StackConfigError(
      [...CMS_APP_KEYS],
      'must be set together. The gateway needs both the app id and the installation id to mint an installation token',
    );
  }

  for (const [key, value] of [
    [CMS_APP_KEYS[0], appId],
    [CMS_APP_KEYS[1], installationId],
  ] as const) {
    if (!NUMERIC_ID_PATTERN.test(value)) {
      throw new StackConfigError(
        [key],
        `must be the numeric id GitHub shows on the app settings page, not its slug, got "${value}"`,
      );
    }
  }

  return { appId, installationId };
}

/**
 * The six values `authenticate-oidc` needs, or a refusal naming every one that is missing.
 *
 * AWS rejects a listener rule with a partial OIDC block, so there is no useful halfway state to
 * accept. Reporting all of them at once means one round trip to the identity team rather than six.
 */
function resolveOidcListener(input: GithubConfigInput): CmsOidcListenerConfig {
  const values = OIDC_LISTENER_KEYS.map((key) => emptyToUndefined(input[key]));
  const missing = OIDC_LISTENER_KEYS.filter((_key, index) => values[index] === undefined);

  if (missing.length > 0) {
    throw new StackConfigError(
      [...missing],
      'are required when cmsAuthMode is "alb": the load balancer performs the OIDC exchange, so it ' +
        'needs the provider endpoints and a client credential',
    );
  }

  const [issuer, authorizationEndpoint, tokenEndpoint, userInfoEndpoint, clientId] = values as [
    string,
    string,
    string,
    string,
    string,
  ];

  return { issuer, authorizationEndpoint, tokenEndpoint, userInfoEndpoint, clientId };
}

/**
 * Resolves how the gateway establishes identity — requirements.md R1, and ADR 0013.
 *
 * Both modes are supported because requirements Q3 ("which IdP fronts this") is still open. What
 * is not supported is guessing: with the App configured and `cmsAuthMode` unset, the stack fails
 * at preview rather than deploying a task that will refuse every author.
 */
function resolveCmsGateway(input: GithubConfigInput): CmsGatewayConfig {
  const mode = emptyToUndefined(input.cmsAuthMode);
  if (mode === undefined || !CMS_AUTH_MODES.includes(mode as CmsAuthMode)) {
    throw new StackConfigError(
      ['cmsAuthMode'],
      `must be one of: ${CMS_AUTH_MODES.join(', ')}. "bearer" verifies a token the editor holds; ` +
        '"alb" verifies the JWT a load balancer running authenticate-oidc signs',
    );
  }

  const pathPrefixes = resolvePathPrefixes(input.cmsPathPrefixes);
  const common = {
    emailClaim: emptyToUndefined(input.cmsAuthEmailClaim),
    nameClaim: emptyToUndefined(input.cmsAuthNameClaim),
    branchPrefix: emptyToUndefined(input.cmsBranchPrefix) ?? DEFAULT_CMS_BRANCH_PREFIX,
    pathPrefixes,
    mediaFolder: resolveMediaFolder(input.cmsMediaFolder, pathPrefixes),
    maxUploadBytes: resolveMaxUploadBytes(input.cmsMaxUploadBytes),
    allowMerge: input.cmsAllowMerge ?? false,
  };

  if (mode === 'alb') {
    if (emptyToUndefined(input.certificateArn) === undefined) {
      throw new StackConfigError(
        ['cmsAuthMode', 'certificateArn'],
        'ALB authentication requires an HTTPS listener, so a certificate must be configured. Use ' +
          'cmsAuthMode "bearer" for a deployment without one',
      );
    }
    return {
      ...common,
      authMode: 'alb',
      issuerUrl: undefined,
      audience: undefined,
      clientId: undefined,
      oidcListener: resolveOidcListener(input),
    };
  }

  const issuerUrl = emptyToUndefined(input.cmsAuthIssuerUrl);
  const audience = emptyToUndefined(input.cmsAuthAudience);
  const clientId = emptyToUndefined(input.cmsAuthClientId);
  const missing = [
    ...(issuerUrl === undefined ? ['cmsAuthIssuerUrl'] : []),
    ...(audience === undefined ? ['cmsAuthAudience'] : []),
    ...(clientId === undefined ? ['cmsAuthClientId'] : []),
  ];
  if (missing.length > 0) {
    throw new StackConfigError(
      missing,
      'are required when cmsAuthMode is "bearer": the gateway verifies the editor\'s token against ' +
        'that issuer, for that audience, and the /publisher editor signs in as that client',
    );
  }

  return { ...common, authMode: 'bearer', issuerUrl, audience, clientId, oidcListener: undefined };
}

/**
 * Prefixes the CMS may write under — requirements.md R3.
 *
 * A blank entry is rejected rather than dropped. In the gateway an empty prefix matches every
 * path, so a stray comma in this list is the difference between "the docs tree" and "the whole
 * repository"; that is worth failing a preview over.
 */
function resolvePathPrefixes(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined) {
    return DEFAULT_CMS_PATH_PREFIXES;
  }

  const prefixes = value.map((prefix) => prefix.trim());
  if (prefixes.length === 0 || prefixes.some((prefix) => prefix === '')) {
    throw new StackConfigError(
      ['cmsPathPrefixes'],
      'must be a non-empty list of repository prefixes such as ["docs/"]. An empty entry would ' +
        'match every path in the repository',
    );
  }
  return prefixes;
}

/**
 * Resolves where uploads go, refusing a folder the gateway could never write to (R15).
 *
 * The containment rule is the gateway's own, checked here as well so a bad value fails at
 * `pulumi preview` rather than in a task that boots, passes `/healthz`, and refuses every upload.
 * Two checks of one rule, in the two places a mistake could be made.
 *
 * @param value - The configured folder, if any.
 * @param pathPrefixes - The already-resolved write prefixes.
 * @returns The folder, with exactly one trailing slash.
 * @throws {StackConfigError} When the folder is malformed or outside every write prefix.
 */
function resolveMediaFolder(value: string | undefined, pathPrefixes: readonly string[]): string {
  const configured = emptyToUndefined(value) ?? DEFAULT_CMS_MEDIA_FOLDER;
  const folder = `${configured.replace(/^\/+/, '').replace(/\/+$/, '')}/`;

  if (folder === '/' || /(^|\/)\.\.?(\/|$)/.test(folder) || folder.includes('\\')) {
    throw new StackConfigError(
      ['cmsMediaFolder'],
      `must be a plain repository folder such as "${DEFAULT_CMS_MEDIA_FOLDER}"`,
    );
  }

  const boundaries = pathPrefixes.map((prefix) => `${prefix.replace(/\/+$/, '')}/`);
  if (!boundaries.some((prefix) => folder.startsWith(prefix))) {
    throw new StackConfigError(
      ['cmsMediaFolder', 'cmsPathPrefixes'],
      `disagree: uploads would go to "${folder}", which is outside ${boundaries.join(', ')}. The ` +
        'gateway would refuse every upload',
    );
  }

  return folder;
}

/**
 * Resolves the per-image upload limit — requirements.md R15.
 *
 * Bounded above as well as below. The proxy endpoint sizes its request-body limit from this, so an
 * unbounded value would let one save hold as much of the task's memory as the author cared to send.
 */
function resolveMaxUploadBytes(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_CMS_MAX_UPLOAD_BYTES;
  }
  if (!Number.isInteger(value) || value < 1 || value > MAX_CMS_MAX_UPLOAD_BYTES) {
    throw new StackConfigError(
      ['cmsMaxUploadBytes'],
      `must be a whole number of bytes between 1 and ${String(MAX_CMS_MAX_UPLOAD_BYTES)}`,
    );
  }
  return value;
}

/**
 * Validates the configuration describing the repository that backs the knowledge base, or throws.
 *
 * Pure and I/O-free for the same reason {@link import('./config').validateStackConfig} is: the
 * whole rule set is unit-testable without a Pulumi engine, credentials or a network.
 *
 * `corpusRepository` is the master switch. Leaving it unset is a supported configuration — the
 * stack then manages no GitHub resources at all — because the AWS half is useful on its own and a
 * GitHub admin token is a real prerequisite, not a formality.
 *
 * @param input - Raw values read from `pulumi.Config`.
 * @returns Validated configuration, or `undefined` when `corpusRepository` is unset.
 * @throws {import('./config').StackConfigError} When a value is unusable, naming every offending key.
 *
 * @example
 * ```ts
 * validateGithubConfig({ corpusRepository: 'm-howard/lugem-kb' });
 * ```
 */
export function validateGithubConfig(input: GithubConfigInput): GithubConfig | undefined {
  const fullName = emptyToUndefined(input.corpusRepository);
  if (fullName === undefined) {
    return undefined;
  }

  if (!REPOSITORY_PATTERN.test(fullName)) {
    throw new StackConfigError(
      ['corpusRepository'],
      `must be "owner/name", got "${fullName}". This is the repository holding the markdown corpus`,
    );
  }

  const separator = fullName.indexOf('/');
  const createRepository = input.corpusRepositoryCreate ?? false;
  const importId = emptyToUndefined(input.corpusRepositoryImportId);

  if (createRepository && importId !== undefined) {
    throw new StackConfigError(
      ['corpusRepositoryCreate', 'corpusRepositoryImportId'],
      'are mutually exclusive: a repository is either created by this stack or adopted from GitHub',
    );
  }

  const cmsApp = resolveCmsApp(input);

  // Reader authentication has no identity provider configuration of its own; it borrows the CMS's.
  // Requiring it without one would deploy an ALB rule pointing at nothing, which fails at apply
  // rather than at preview. Decoupling the two is recorded as a follow-up in ADR 0017.
  if ((input.readerAuthRequired ?? false) && cmsApp === undefined) {
    throw new StackConfigError(
      ['readerAuthRequired', 'cmsGitHubAppId'],
      'reader authentication currently reuses the editorial identity provider, so it cannot be ' +
        'required on a stack with no CMS configured',
    );
  }

  return {
    owner: fullName.slice(0, separator),
    repository: fullName.slice(separator + 1),
    fullName,
    description: emptyToUndefined(input.corpusRepositoryDescription),
    defaultBranch: resolveDefaultBranch(input.corpusDefaultBranch),
    manageRepositoryResource: createRepository || importId !== undefined,
    createRepository,
    importId,
    requiredStatusChecks: resolveStatusChecks(input.requiredStatusChecks),
    oidcProviderArn: resolveOidcProviderArn(input.githubOidcProviderArn),
    cmsApp,
    cmsGateway: cmsApp === undefined ? undefined : resolveCmsGateway(input),
  };
}
