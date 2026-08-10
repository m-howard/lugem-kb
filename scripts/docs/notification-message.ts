/** What happened, from the point of view of the person being told about it. */
export type NotificationKind = 'review-requested' | 'published' | 'changes-requested';

/**
 * Stripped from anything that reaches a header.
 *
 * A pull request title is whatever somebody typed. Carried into a subject line unaltered, a
 * carriage return or newline ends the header and starts another — which is how a title becomes an
 * extra `Bcc:`. SES rejects most of it, but the guard belongs here rather than in a provider's
 * validation, because the provider is a detail and this is the property.
 */
const HEADER_BREAKS = /[\r\n]+/g;

/** Long enough to identify a change, short enough that a phone shows the end of it. */
const MAX_SUBJECT_TITLE = 120;

/** Enough to see the shape of a change without pasting a rename of the whole corpus into an email. */
const MAX_LISTED_PATHS = 20;

export interface PullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly submitterName: string | undefined;
  readonly changedPaths: readonly string[];
}

export interface Notification {
  readonly subject: string;
  readonly body: string;
}

function singleLine(text: string, limit: number): string {
  const flattened = text.replace(HEADER_BREAKS, ' ').replace(/\s+/g, ' ').trim();
  return flattened.length > limit ? `${flattened.slice(0, limit)}…` : flattened;
}

const SUBJECT_PREFIXES: Readonly<Record<NotificationKind, string>> = {
  'review-requested': 'Docs review needed',
  published: 'Published',
  'changes-requested': 'Changes requested',
};

function renderPaths(paths: readonly string[]): readonly string[] {
  if (paths.length === 0) {
    return [];
  }

  const shown = paths.slice(0, MAX_LISTED_PATHS).map((path) => `  - ${path}`);
  const remainder = paths.length - shown.length;
  return [
    '',
    'Pages changed:',
    ...shown,
    ...(remainder > 0 ? [`  …and ${String(remainder)} more`] : []),
  ];
}

function openingLine(kind: NotificationKind, pull: PullRequestSummary): string {
  const who = pull.submitterName ?? 'Someone';
  switch (kind) {
    case 'review-requested':
      return `${who} submitted a documentation change that needs your review.`;
    case 'published':
      return 'Your documentation change has been approved and published.';
    case 'changes-requested':
      return 'A reviewer has asked for changes on your documentation submission.';
  }
}

function closingLines(kind: NotificationKind): readonly string[] {
  switch (kind) {
    case 'review-requested':
      return [
        '',
        'You are receiving this because CODEOWNERS names you as the owner of the pages above.',
      ];
    case 'published':
      return ['', 'It is live on the docs site, and answerable in chat within about 15 minutes.'];
    case 'changes-requested':
      return ['', 'Open the page in the CMS to make the changes and submit it again.'];
  }
}

/**
 * Renders a review notification as plain text (requirements.md R14).
 *
 * Plain text on purpose: it renders in every client, and it means a title, a name and a set of
 * paths — none of which this system authored — can never become markup in somebody's inbox.
 *
 * @param kind - Which of R14's three moments this is.
 * @param pull - The pull request being reported on.
 * @returns A subject and body ready to hand to a mail provider.
 *
 * @example
 * ```ts
 * buildNotification('published', { number: 42, title: 'Rewrite leave policy', ...rest });
 * // → { subject: 'Published: Rewrite leave policy (#42)', body: '…' }
 * ```
 */
export function buildNotification(kind: NotificationKind, pull: PullRequestSummary): Notification {
  const title = singleLine(pull.title, MAX_SUBJECT_TITLE);
  const subject = `${SUBJECT_PREFIXES[kind]}: ${title} (#${String(pull.number)})`;

  const body = [
    openingLine(kind, pull),
    '',
    `  ${title}`,
    `  ${pull.url}`,
    ...(kind === 'review-requested' ? renderPaths(pull.changedPaths) : []),
    ...closingLines(kind),
    '',
    '—',
    'Sent by the Lugem documentation gateway. Replies are not monitored.',
  ].join('\n');

  return { subject: singleLine(subject, subject.length), body };
}
