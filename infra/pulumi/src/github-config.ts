import { StackConfigError } from './config';

/** Owner is alphanumeric with internal hyphens; a repository name also allows dot and underscore. */
const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

/** GitHub app and installation ids are integers, and pasting the app *slug* instead is the usual slip. */
const NUMERIC_ID_PATTERN = /^\d+$/;

const OIDC_PROVIDER_ARN_MARKER = ':oidc-provider/';

const DEFAULT_BRANCH = 'main';

const CMS_APP_KEYS = ['cmsGitHubAppId', 'cmsGitHubAppInstallationId'] as const;

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
}

/** The GitHub App the gateway authenticates as — requirements.md R2. */
export interface CmsAppConfig {
  readonly appId: string;
  readonly installationId: string;
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
    cmsApp: resolveCmsApp(input),
  };
}
