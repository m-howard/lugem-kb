import * as github from '@pulumi/github';
import * as pulumi from '@pulumi/pulumi';

import { type GithubConfig } from '../github-config';

const REQUIRED_APPROVALS = 1;

/** Actions this repository's workflows use that GitHub does not own or verify. */
const ALLOWED_ACTION_PATTERNS = [
  'oven-sh/setup-bun@*',
  'pulumi/actions@*',
  'aws-actions/configure-aws-credentials@*',
];

/** The labels `.github/ISSUE_TEMPLATE/*.yml` apply. Templates reference them; nothing defined them. */
const ISSUE_LABELS = [
  { name: 'bug', color: 'd73a4a', description: 'Something is not working' },
  { name: 'enhancement', color: 'a2eeef', description: 'A new capability or improvement' },
  { name: 'documentation', color: '0075ca', description: 'A change to the corpus' },
];

const SEEDED_CODEOWNERS = `# Every documentation directory maps to the team accountable for it, which is what turns the
# \`owner\` frontmatter field on each page into a review request (requirements.md R8).
* @OWNER
/docs/ @OWNER
`;

export interface CorpusRepositoryArgs {
  readonly config: GithubConfig;
}

/**
 * The GitHub repository backing the knowledge base, and the rules that govern changes to it.
 *
 * The ruleset is requirements.md R8 expressed as infrastructure: code-owner review on the default
 * branch, and `bypassActors: []` so no principal — not an administrator, and pointedly not the CMS
 * GitHub App — can push straight to it. That empty list is the whole point of managing this in code
 * rather than in the settings UI, where a bypass entry added once is invisible forever after.
 *
 * The `github.Repository` resource itself is only managed when the stack is told to create or adopt
 * one. Pointing `corpusRepository` at a repository without either flag configures the rules and
 * leaves the repository's own settings alone.
 *
 * @example
 * ```ts
 * const repo = new CorpusRepository('lugem-kb-dev', { config: githubConfig }, { providers });
 * ```
 */
export class CorpusRepository extends pulumi.ComponentResource {
  public readonly fullName: pulumi.Output<string>;
  public readonly name: pulumi.Output<string>;
  public readonly defaultBranch: pulumi.Output<string>;

  constructor(name: string, args: CorpusRepositoryArgs, opts?: pulumi.ComponentResourceOptions) {
    super('lugem:github:CorpusRepository', name, {}, opts);

    const { config } = args;
    const repository = config.manageRepositoryResource
      ? this.createRepository(name, config)
      : undefined;

    // Every rule below addresses the repository by name, so the governance applies whether or not
    // this stack owns the repository resource.
    const repositoryName = repository?.name ?? pulumi.output(config.repository);

    this.createRuleset(name, config, repositoryName);
    this.createHardening(name, repositoryName, repository === undefined);

    if (config.createRepository) {
      // Only when this stack created the repository. Adopting one that already tracks CODEOWNERS
      // in git would give the same path two owners, and the loser is whichever wrote last.
      new github.RepositoryFile(
        `${name}-codeowners`,
        {
          repository: repositoryName,
          branch: config.defaultBranch,
          file: '.github/CODEOWNERS',
          content: SEEDED_CODEOWNERS.replace(/@OWNER/g, `@${config.owner}`),
          commitMessage: 'chore: seed codeowners for the corpus',
          overwriteOnCreate: false,
        },
        { parent: this },
      );
    }

    this.fullName = repository?.fullName ?? pulumi.output(config.fullName);
    this.name = repositoryName;
    // The configured value, not the repository's reported one: `Repository.defaultBranch` is
    // deprecated, and this is the branch the ruleset and the publish workflow are written against.
    this.defaultBranch = pulumi.output(config.defaultBranch);

    this.registerOutputs({
      fullName: this.fullName,
      name: this.name,
      defaultBranch: this.defaultBranch,
    });
  }

  /**
   * Repository settings, matching the git workflow AGENTS.md already states rather than inventing
   * a second one: squash merges only, branches deleted after merge.
   *
   * `archiveOnDestroy` is the important one. `pulumi destroy` must never delete the corpus — the
   * same instinct as `forceDestroy: false` on the bucket holding its published copy.
   */
  private createRepository(name: string, config: GithubConfig): github.Repository {
    const importOptions: pulumi.CustomResourceOptions =
      config.importId === undefined ? {} : { import: config.importId };

    return new github.Repository(
      `${name}-corpus-repo`,
      {
        name: config.repository,
        ...(config.description === undefined ? {} : { description: config.description }),
        ...(config.createRepository ? { visibility: 'private', autoInit: true } : {}),
        allowSquashMerge: true,
        allowMergeCommit: false,
        allowRebaseMerge: false,
        allowAutoMerge: true,
        deleteBranchOnMerge: true,
        squashMergeCommitTitle: 'PR_TITLE',
        squashMergeCommitMessage: 'PR_BODY',
        hasIssues: true,
        hasProjects: false,
        hasWiki: false,
        vulnerabilityAlerts: true,
        archiveOnDestroy: true,
      },
      { parent: this, ...importOptions },
    );
  }

  private createRuleset(
    name: string,
    config: GithubConfig,
    repositoryName: pulumi.Input<string>,
  ): void {
    const requiredStatusChecks =
      config.requiredStatusChecks.length === 0
        ? {}
        : {
            requiredStatusChecks: {
              strictRequiredStatusChecksPolicy: true,
              requiredChecks: config.requiredStatusChecks.map((context) => ({ context })),
            },
          };

    new github.RepositoryRuleset(
      `${name}-default-branch-ruleset`,
      {
        name: 'default-branch-protection',
        repository: repositoryName,
        target: 'branch',
        enforcement: 'active',
        // R8: direct pushes to the default branch are blocked for all principals including the app.
        bypassActors: [],
        conditions: { refName: { includes: ['~DEFAULT_BRANCH'], excludes: [] } },
        rules: {
          deletion: true,
          nonFastForward: true,
          requiredLinearHistory: true,
          pullRequest: {
            requiredApprovingReviewCount: REQUIRED_APPROVALS,
            requireCodeOwnerReview: true,
            dismissStaleReviewsOnPush: true,
            requireLastPushApproval: true,
            requiredReviewThreadResolution: true,
            allowedMergeMethods: ['squash'],
          },
          ...requiredStatusChecks,
        },
      },
      { parent: this },
    );
  }

  private createHardening(
    name: string,
    repositoryName: pulumi.Input<string>,
    ensureAlerts: boolean,
  ): void {
    if (ensureAlerts) {
      // When this stack does not own the repository resource, nothing else turns alerts on — and
      // Dependabot security updates cannot be enabled without them.
      new github.RepositoryVulnerabilityAlerts(
        `${name}-vulnerability-alerts`,
        { repository: repositoryName, enabled: true },
        { parent: this },
      );
    }

    new github.RepositoryDependabotSecurityUpdates(
      `${name}-dependabot-security-updates`,
      { repository: repositoryName, enabled: true },
      { parent: this },
    );

    new github.ActionsRepositoryPermissions(
      `${name}-actions-permissions`,
      {
        repository: repositoryName,
        enabled: true,
        allowedActions: 'selected',
        allowedActionsConfig: {
          githubOwnedAllowed: true,
          verifiedAllowed: true,
          patternsAlloweds: ALLOWED_ACTION_PATTERNS,
        },
      },
      { parent: this },
    );

    // Workflows declare the permissions they need; the default token should grant nothing more.
    new github.WorkflowRepositoryPermissions(
      `${name}-workflow-permissions`,
      {
        repository: repositoryName,
        defaultWorkflowPermissions: 'read',
        canApprovePullRequestReviews: false,
      },
      { parent: this },
    );

    new github.IssueLabels(
      `${name}-issue-labels`,
      { repository: repositoryName, labels: ISSUE_LABELS },
      { parent: this },
    );
  }
}
