import { CmsPolicyError } from './errors';
import { type CmsSettings } from './settings';
import { type Identity } from '../auth/claims';
import { buildSubmissionBody } from '../git/attribution';
import { resolveBranch } from '../git/branch-policy';
import { type GitHubClient } from '../git/github-client';

export interface SubmitRequest {
  readonly branch: string;
  readonly title: string;
  readonly summary?: string | undefined;
}

export interface Submission {
  readonly number: number;
  readonly branch: string;
  /** Where this submission would land. Carried so a merge can be refused before it is attempted. */
  readonly base: string;
  readonly title: string;
  readonly state: string;
  readonly url: string;
  /** `null` until the git host has worked out whether the branch merges cleanly. */
  readonly mergeable: boolean | null;
}

interface PullResponse {
  readonly number?: number;
  readonly title?: string;
  readonly state?: string;
  readonly merged?: boolean;
  readonly mergeable?: boolean | null;
  readonly html_url?: string;
  readonly head?: { readonly ref?: string };
  readonly base?: { readonly ref?: string };
}

export interface SubmissionServiceOptions {
  readonly client: GitHubClient;
  readonly settings: CmsSettings;
  /**
   * requirements.md R7 and R16. Checked here as well as in the endpoint allowlist, on purpose:
   * this one refuses before any upstream call, and the allowlist still refuses a caller that
   * reaches the client some other way. Neither is redundant — they guard different mistakes.
   */
  readonly allowMerge: boolean;
}

function toSubmission(pull: PullResponse): Submission {
  return {
    number: pull.number ?? 0,
    branch: pull.head?.ref ?? '',
    base: pull.base?.ref ?? '',
    title: pull.title ?? '',
    state: pull.merged === true ? 'merged' : (pull.state ?? 'unknown'),
    url: pull.html_url ?? '',
    mergeable: pull.mergeable ?? null,
  };
}

/**
 * Submitting a draft for review, and reporting where it got to (requirements.md R7).
 *
 * Submitting opens a pull request against the default branch and nothing else. The base is taken
 * from configuration rather than from the request, so "pull requests targeting anything other than
 * the default branch are refused" (R4) holds because there is no way to express one — not because
 * a check rejects it.
 *
 * Merging is refused unless `POLICY_ALLOW_MERGE_FROM_CMS` is set, and even then only for the
 * service's own submissions — see {@link merge}. The flag is what R16 anticipates: moving approval
 * into the CMS becomes configuration plus a UI, not a rewrite.
 */
export class SubmissionService {
  readonly #client: GitHubClient;
  readonly #settings: CmsSettings;
  readonly #allowMerge: boolean;

  constructor(options: SubmissionServiceOptions) {
    this.#client = options.client;
    this.#settings = options.settings;
    this.#allowMerge = options.allowMerge;
  }

  /**
   * Opens a pull request for a draft branch.
   *
   * @param request - The draft branch, a title, and the author's optional summary.
   * @param identity - The verified submitter, named in the body.
   * @returns The submission an author can watch.
   * @throws {CmsPolicyError} When the branch is not one the CMS owns.
   */
  async submit(request: SubmitRequest, identity: Identity): Promise<Submission> {
    const branch = this.#resolveDraftBranch(request.branch);
    const title = request.title.trim();
    if (title === '') {
      throw new CmsPolicyError('empty-title', 'A submission needs a title for its reviewer.');
    }

    const response = await this.#client.request<PullResponse>('POST', this.#client.path('/pulls'), {
      title,
      head: branch,
      base: this.#settings.defaultBranch,
      body: buildSubmissionBody({ branch, summary: request.summary }, identity),
      maintainer_can_modify: true,
    });

    return toSubmission(response.body);
  }

  /**
   * Lists submissions, newest first.
   *
   * @param branch - Narrow to one draft branch. Omit for every open submission.
   * @returns The submissions.
   */
  async list(branch?: string): Promise<readonly Submission[]> {
    const owner = this.#settings.repository.split('/')[0] ?? '';
    const head =
      branch === undefined
        ? ''
        : `&head=${encodeURIComponent(`${owner}:${this.#resolveDraftBranch(branch)}`)}`;

    const response = await this.#client.request<readonly PullResponse[]>(
      'GET',
      this.#client.path(`/pulls?state=all&sort=created&direction=desc${head}`),
    );

    return response.body.map(toSubmission);
  }

  /**
   * Reads one submission, which is how the CMS shows an author where their change got to.
   *
   * @param number - Pull request number.
   * @returns The submission.
   */
  async read(number: number): Promise<Submission> {
    const response = await this.#client.request<PullResponse>(
      'GET',
      this.#client.path(`/pulls/${String(number)}`),
    );

    return toSubmission(response.body);
  }

  /**
   * Merges a submission, once it is established that the submission is one of ours.
   *
   * The endpoint allowlist cannot make this decision. `PUT /pulls/42/merge` is a well-formed,
   * permitted call whatever 42 turns out to be, so with `POLICY_ALLOW_MERGE_FROM_CMS` set an
   * author could otherwise merge any open pull request in the repository — a colleague's release
   * branch into the default branch, reviewed by nobody. Confinement here has to look at the pull
   * request rather than at the URL, which means reading it first.
   *
   * Both refs are checked, because either one alone would leave a hole: a CMS head could target a
   * protected branch that is not the default, and a non-CMS head could target the default branch.
   *
   * @param number - Pull request number.
   * @returns The submission's state after the merge.
   * @throws {CmsPolicyError} When the pull request is not a CMS submission. Nothing is merged.
   */
  async merge(number: number): Promise<Submission> {
    if (!this.#allowMerge) {
      throw new CmsPolicyError(
        'merge-disabled',
        'Merging happens in the git host, where branch protection can require an owner approval. ' +
          'Set POLICY_ALLOW_MERGE_FROM_CMS only once that review moves here.',
      );
    }

    const submission = await this.read(number);
    this.#requireOwnSubmission(submission);

    await this.#client.request('PUT', this.#client.path(`/pulls/${String(number)}/merge`), {
      merge_method: 'squash',
    });

    return this.read(number);
  }

  #requireOwnSubmission(submission: Submission): void {
    const head = resolveBranch(submission.branch, {
      prefix: this.#settings.branchPrefix,
      defaultBranch: this.#settings.defaultBranch,
      operation: 'update',
    });
    if (!head.ok) {
      throw new CmsPolicyError(
        'foreign-submission',
        `Pull request ${String(submission.number)} is from "${submission.branch}", which the CMS ` +
          'does not own. Merge it in the git host.',
      );
    }

    if (submission.base !== this.#settings.defaultBranch) {
      throw new CmsPolicyError(
        'foreign-base',
        `Pull request ${String(submission.number)} targets "${submission.base}", not the default ` +
          `branch "${this.#settings.defaultBranch}".`,
      );
    }
  }

  #resolveDraftBranch(branch: string): string {
    const resolved = resolveBranch(branch, {
      prefix: this.#settings.branchPrefix,
      defaultBranch: this.#settings.defaultBranch,
      operation: 'update',
    });
    if (!resolved.ok) {
      throw new CmsPolicyError(resolved.reason, resolved.message);
    }
    return resolved.branch;
  }
}
