import { type Identity } from '../auth/claims';

const TRAILER = 'Co-authored-by';

export interface CommitAuthor {
  readonly name: string;
  readonly email: string;
}

export interface CommitRequest {
  readonly message: string;
  readonly tree: string;
  readonly parents: readonly string[];
}

export interface CommitPayload extends CommitRequest {
  readonly author: CommitAuthor;
}

/**
 * The trailer line for an identity, in the form git hosts recognise.
 *
 * @param identity - The verified author.
 * @returns `Co-authored-by: Name <email>`.
 */
export function coAuthorTrailer(identity: Identity): string {
  return `${TRAILER}: ${identity.name} <${identity.email}>`;
}

/**
 * Appends the co-author trailer, unless the message already carries it.
 *
 * Idempotence is the requirement, not a nicety: R6 asks for the trailer "added exactly once even
 * on retry", and a save that is retried after a network timeout runs this function again on a
 * message that already has it. Comparing the whole line rather than just the email means a second
 * author's trailer is still added.
 *
 * @param message - The commit message as composed so far.
 * @param identity - The verified author.
 * @returns The message with exactly one trailer for this author.
 */
export function withCoAuthorTrailer(message: string, identity: Identity): string {
  const trailer = coAuthorTrailer(identity);
  const body = message.trimEnd();

  if (body.split('\n').some((line) => line.trim() === trailer)) {
    return body;
  }
  return `${body}\n\n${trailer}`;
}

/**
 * Builds the commit the git host will record (requirements.md R6).
 *
 * Two things here are the whole point of the function:
 *
 * - **The author comes from the verified token.** The client's request has no author field to
 *   supply; this signature makes that structural rather than a rule someone has to remember. A
 *   commit is a durable claim about who wrote something, and the CMS is not entitled to make it
 *   on someone else's behalf.
 * - **There is no `committer`.** Omitting it leaves the git host recording the App as committer,
 *   which is accurate: the App is what performed the write. Setting it to the human would make
 *   git history say a person pushed when no person could — none of them has a git host account,
 *   which is the problem this whole system exists to solve.
 *
 * @param request - Message, tree and parents of the commit to create.
 * @param identity - The verified author.
 * @returns The payload for `POST /git/commits`.
 *
 * @example
 * ```ts
 * buildCommitPayload({ message: 'docs: rewrite leave policy', tree: 't1', parents: ['c1'] }, identity);
 * // → { message: 'docs: rewrite leave policy\n\nCo-authored-by: Sam Okoro <sam@example.com>',
 * //      tree: 't1', parents: ['c1'], author: { name: 'Sam Okoro', email: 'sam@example.com' } }
 * ```
 */
export function buildCommitPayload(request: CommitRequest, identity: Identity): CommitPayload {
  return {
    message: withCoAuthorTrailer(request.message, identity),
    tree: request.tree,
    parents: request.parents,
    author: { name: identity.name, email: identity.email },
  };
}

export interface SubmissionRequest {
  readonly branch: string;
  readonly summary?: string | undefined;
}

/**
 * Builds the pull request body (requirements.md R6: it names the submitter and their email).
 *
 * The reviewer is the audience. They are being asked to approve someone else's words, and the
 * first thing they need is whose — the commit author says it too, but a reviewer reads the
 * description first and often only.
 *
 * @param request - The draft branch and the author's own summary, if they wrote one.
 * @param identity - The verified submitter.
 * @returns Markdown for the pull request body.
 */
export function buildSubmissionBody(request: SubmissionRequest, identity: Identity): string {
  const lines = [
    `Submitted by **${identity.name}** <${identity.email}> through the documentation CMS.`,
    '',
    `Draft branch: \`${request.branch}\``,
  ];

  const summary = request.summary?.trim();
  if (summary !== undefined && summary !== '') {
    lines.push('', '---', '', summary);
  }

  return lines.join('\n');
}
