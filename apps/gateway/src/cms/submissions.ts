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
}

export interface SubmissionServiceOptions {
  readonly client: GitHubClient;
  readonly settings: CmsSettings;
}

function toSubmission(pull: PullResponse): Submission {
  return {
    number: pull.number ?? 0,
    branch: pull.head?.ref ?? '',
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
 * Merging is not implemented here on purpose. The endpoint exists so the CMS gets an honest 403
 * rather than a 404, and the refusal lives in the endpoint allowlist where the
 * `POLICY_ALLOW_MERGE_FROM_CMS` flag can lift it later (R16) without new code paths.
 */
export class SubmissionService {
  readonly #client: GitHubClient;
  readonly #settings: CmsSettings;

  constructor(options: SubmissionServiceOptions) {
    this.#client = options.client;
    this.#settings = options.settings;
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

    const response = await this.#client.request<PullResponse>(
      'POST',
      this.#client.path('/pulls'),
      {
        title,
        head: branch,
        base: this.#settings.defaultBranch,
        body: buildSubmissionBody({ branch, summary: request.summary }, identity),
        maintainer_can_modify: true,
      },
    );

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
    const head = branch === undefined ? '' : `&head=${encodeURIComponent(`${owner}:${this.#resolveDraftBranch(branch)}`)}`;

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
   * Merges a submission — refused by the endpoint allowlist unless the policy flag is set.
   *
   * @param number - Pull request number.
   * @returns The submission's state after the attempt.
   */
  async merge(number: number): Promise<Submission> {
    await this.#client.request('PUT', this.#client.path(`/pulls/${String(number)}/merge`), {
      merge_method: 'squash',
    });

    return this.read(number);
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
