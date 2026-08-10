import { describe, expect, it } from 'vitest';

import { classifyEvent, type PullRequestEvent } from './notification-event';

const OPEN_PULL: PullRequestEvent['pull_request'] = {
  number: 42,
  title: 'Rewrite the leave policy',
  html_url: 'https://github.com/m-howard/lugem-kb/pull/42',
  head: { ref: 'cms/leave-policy' },
};

describe('classifyEvent', () => {
  it.each(['opened', 'reopened', 'ready_for_review'])('asks for review on %s', (action) => {
    expect(classifyEvent('pull_request_target', { action, pull_request: OPEN_PULL })).toBe(
      'review-requested',
    );
  });

  it('treats a plain pull_request delivery the same way', () => {
    expect(classifyEvent('pull_request', { action: 'opened', pull_request: OPEN_PULL })).toBe(
      'review-requested',
    );
  });

  // A draft is not finished. GitHub sends `opened` for one all the same.
  it('stays quiet for a draft', () => {
    expect(
      classifyEvent('pull_request_target', {
        action: 'opened',
        pull_request: { ...OPEN_PULL, draft: true },
      }),
    ).toBeUndefined();
  });

  it('reports a merge as published', () => {
    expect(
      classifyEvent('pull_request_target', {
        action: 'closed',
        pull_request: { ...OPEN_PULL, merged: true },
      }),
    ).toBe('published');
  });

  // Closed without merging is a withdrawal, and telling an author it was "published" is worse
  // than telling them nothing.
  it('stays quiet when a pull request is closed unmerged', () => {
    expect(
      classifyEvent('pull_request_target', {
        action: 'closed',
        pull_request: { ...OPEN_PULL, merged: false },
      }),
    ).toBeUndefined();
  });

  it('reports a changes-requested review', () => {
    expect(
      classifyEvent('pull_request_review', {
        action: 'submitted',
        review: { state: 'changes_requested' },
        pull_request: OPEN_PULL,
      }),
    ).toBe('changes-requested');
  });

  it.each(['approved', 'commented', 'dismissed'])('stays quiet for a %s review', (state) => {
    expect(
      classifyEvent('pull_request_review', {
        action: 'submitted',
        review: { state },
        pull_request: OPEN_PULL,
      }),
    ).toBeUndefined();
  });

  it.each([
    ['a synchronise push', { action: 'synchronize', pull_request: OPEN_PULL }],
    ['a label change', { action: 'labeled', pull_request: OPEN_PULL }],
    ['a payload with no action', { pull_request: OPEN_PULL }],
    ['a payload with no pull request', { action: 'opened' }],
  ])('stays quiet for %s', (_case, payload) => {
    expect(classifyEvent('pull_request_target', payload)).toBeUndefined();
  });

  it('ignores an event it does not handle', () => {
    expect(classifyEvent('push', { pull_request: OPEN_PULL })).toBeUndefined();
  });
});
