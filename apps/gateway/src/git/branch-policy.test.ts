import { describe, expect, it } from 'vitest';

import {
  type BranchOperation,
  type BranchPolicyViolation,
  resolveBranch,
} from './branch-policy';

const OPTIONS = { prefix: 'cms/', defaultBranch: 'main' } as const;
const WRITES: readonly BranchOperation[] = ['create', 'update', 'delete'];

describe('resolveBranch', () => {
  // R4: "Creating cms/<name> succeeds."
  it.each(WRITES)('allows %s under the configured prefix', (operation) => {
    expect(resolveBranch('cms/pricing', { ...OPTIONS, operation })).toEqual({
      ok: true,
      branch: 'cms/pricing',
      ref: 'refs/heads/cms/pricing',
    });
  });

  // The git data API accepts both spellings for the same branch. A policy that understood only
  // one of them would be a policy in name only.
  it('resolves a qualified ref and a bare name identically', () => {
    const bare = resolveBranch('cms/pricing', { ...OPTIONS, operation: 'update' });
    const qualified = resolveBranch('refs/heads/cms/pricing', { ...OPTIONS, operation: 'update' });

    expect(qualified).toEqual(bare);
  });

  it('reads the default branch, which is where a draft is based from', () => {
    expect(resolveBranch('main', { ...OPTIONS, operation: 'read' })).toMatchObject({
      ok: true,
      ref: 'refs/heads/main',
    });
  });

  // R4: "Creating, updating or deleting the default branch is refused with 403." The repository
  // ruleset blocks it too (bypassActors: []), but a gateway that relied on that would be one
  // misconfigured ruleset away from writing to published content.
  it.each(WRITES)('refuses %s on the default branch', (operation) => {
    const result = resolveBranch('main', { ...OPTIONS, operation });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: 'default-branch' });
  });

  it('refuses the default branch by its qualified ref too', () => {
    expect(resolveBranch('refs/heads/main', { ...OPTIONS, operation: 'delete' })).toMatchObject({
      ok: false,
      reason: 'default-branch',
    });
  });

  // R4: "Updating or deleting a branch outside the prefix is refused."
  describe('refuses', () => {
    const cases: readonly [string, string, BranchPolicyViolation][] = [
      ['a branch outside the prefix', 'feature/pricing', 'outside-prefix'],
      ['a prefix lookalike', 'cmsx/pricing', 'outside-prefix'],
      ['a release branch', 'release/2026-08', 'outside-prefix'],
      ['an empty name', '', 'empty'],
      ['a bare qualified prefix', 'refs/heads/', 'empty'],
      ['traversal', 'cms/../main', 'malformed'],
      ['a glob', 'cms/*', 'malformed'],
      ['a ref-log expression', 'cms/pricing@{1}', 'malformed'],
      ['a caret', 'cms/pricing^', 'malformed'],
      ['a colon', 'cms/a:b', 'malformed'],
      ['a backslash', 'cms\\pricing', 'malformed'],
      ['a space', 'cms/my branch', 'malformed'],
      ['a null byte', 'cms/pricing\0', 'malformed'],
      ['a trailing slash', 'cms/pricing/', 'malformed'],
      ['an empty segment', 'cms//pricing', 'malformed'],
      ['a .lock suffix', 'cms/pricing.lock', 'malformed'],
      ['a dot segment', 'cms/.hidden', 'malformed'],
    ];

    it.each(cases)('%s', (_case, input, reason) => {
      const result = resolveBranch(input, { ...OPTIONS, operation: 'update' });

      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ reason });
    });
  });

  // Stricter than R4 asks. The editorial workflow only ever reads the default branch or one of
  // its own drafts, so forbidding the rest costs nothing and removes a way to enumerate the repo.
  it('refuses reads of a branch that is neither the default nor its own', () => {
    expect(resolveBranch('feature/secret', { ...OPTIONS, operation: 'read' })).toMatchObject({
      ok: false,
      reason: 'outside-prefix',
    });
  });

  // An unset prefix would make `startsWith('')` true for every branch. Fail closed instead.
  it('refuses every branch when no prefix is configured', () => {
    expect(
      resolveBranch('cms/pricing', { prefix: '', defaultBranch: 'main', operation: 'create' }),
    ).toMatchObject({ ok: false, reason: 'outside-prefix' });
  });

  it('honours a different default branch', () => {
    const options = { prefix: 'cms/', defaultBranch: 'trunk', operation: 'delete' } as const;

    expect(resolveBranch('trunk', options)).toMatchObject({ reason: 'default-branch' });
    expect(resolveBranch('main', options)).toMatchObject({ reason: 'outside-prefix' });
  });
});
