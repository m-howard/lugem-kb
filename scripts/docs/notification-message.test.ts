import { describe, expect, it } from 'vitest';

import { buildNotification, type PullRequestSummary } from './notification-message';

const PULL: PullRequestSummary = {
  number: 42,
  title: 'Rewrite the leave policy',
  url: 'https://github.com/m-howard/lugem-kb/pull/42',
  submitterName: 'Sam Okoro',
  changedPaths: ['docs/people/leave.md'],
};

describe('buildNotification', () => {
  it.each([
    ['review-requested', 'Docs review needed: Rewrite the leave policy (#42)'],
    ['published', 'Published: Rewrite the leave policy (#42)'],
    ['changes-requested', 'Changes requested: Rewrite the leave policy (#42)'],
  ] as const)('titles a %s message', (kind, subject) => {
    expect(buildNotification(kind, PULL).subject).toBe(subject);
  });

  it('names the submitter and links the pull request when asking for review', () => {
    const { body } = buildNotification('review-requested', PULL);

    expect(body).toContain('Sam Okoro submitted a documentation change that needs your review.');
    expect(body).toContain('https://github.com/m-howard/lugem-kb/pull/42');
  });

  it('lists the changed pages on a review request', () => {
    expect(buildNotification('review-requested', PULL).body).toContain('- docs/people/leave.md');
  });

  // The author already knows what they changed; the reviewer is the one who needs the list.
  it('omits the page list from the messages sent to the author', () => {
    expect(buildNotification('published', PULL).body).not.toContain('Pages changed:');
    expect(buildNotification('changes-requested', PULL).body).not.toContain('Pages changed:');
  });

  it('truncates a very long page list rather than pasting the whole corpus in', () => {
    const changedPaths = Array.from(
      { length: 25 },
      (_unused, index) => `docs/page-${String(index)}.md`,
    );

    const { body } = buildNotification('review-requested', { ...PULL, changedPaths });

    expect(body).toContain('docs/page-19.md');
    expect(body).not.toContain('docs/page-20.md');
    expect(body).toContain('…and 5 more');
  });

  it('falls back when there is no submitter name', () => {
    const { body } = buildNotification('review-requested', { ...PULL, submitterName: undefined });

    expect(body).toContain('Someone submitted a documentation change');
  });

  // A pull request title is whatever somebody typed. Carried into a subject unaltered, a newline
  // ends the header and starts another — which is how a title becomes an extra `Bcc:`.
  it('strips line breaks out of the subject', () => {
    const title = 'Innocent title\r\nBcc: everyone@example.com';

    const { subject } = buildNotification('published', { ...PULL, title });

    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject).toBe('Published: Innocent title Bcc: everyone@example.com (#42)');
  });

  it('truncates an overlong title', () => {
    const { subject } = buildNotification('published', { ...PULL, title: 'x'.repeat(200) });

    expect(subject).toContain('…');
    expect(subject.length).toBeLessThan('Published: '.length + 130);
  });

  it('says where the notification came from', () => {
    expect(buildNotification('published', PULL).body).toContain(
      'Sent by the Lugem documentation gateway.',
    );
  });
});
