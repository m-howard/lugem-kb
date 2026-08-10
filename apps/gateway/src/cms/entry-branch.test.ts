import { describe, expect, it } from 'vitest';

import { branchForEntry, type EntryRef, parseEntryBranch } from './entry-branch';
import { CmsPolicyError } from './errors';
import { type CmsSettings } from './settings';

const SETTINGS: CmsSettings = {
  repository: 'acme/handbook',
  defaultBranch: 'main',
  branchPrefix: 'cms/',
  pathPrefixes: ['docs/'],
};

describe('branchForEntry', () => {
  it('names a branch under the CMS prefix', () => {
    expect(branchForEntry({ collection: 'guides', slug: 'leave-policy' }, SETTINGS)).toBe(
      'cms/guides/leave-policy',
    );
  });

  it('keeps a nested slug intact, so subfolder collections work', () => {
    expect(branchForEntry({ collection: 'adr', slug: '2026/0015-decap' }, SETTINGS)).toBe(
      'cms/adr/2026/0015-decap',
    );
  });

  it('trims surrounding whitespace', () => {
    expect(branchForEntry({ collection: ' guides ', slug: ' pricing ' }, SETTINGS)).toBe(
      'cms/guides/pricing',
    );
  });

  it('normalises a prefix configured without a trailing slash', () => {
    expect(
      branchForEntry(
        { collection: 'guides', slug: 'pricing' },
        { ...SETTINGS, branchPrefix: 'cms' },
      ),
    ).toBe('cms/guides/pricing');
  });

  describe('refuses', () => {
    const cases: readonly [string, EntryRef][] = [
      ['an empty collection', { collection: '', slug: 'pricing' }],
      ['a whitespace-only collection', { collection: '   ', slug: 'pricing' }],
      ['an empty slug', { collection: 'guides', slug: '' }],
      ['a whitespace-only slug', { collection: 'guides', slug: '   ' }],
      ['a collection containing a slash', { collection: 'guides/internal', slug: 'pricing' }],
    ];

    it.each(cases)('%s', (_case, entry) => {
      expect(() => branchForEntry(entry, SETTINGS)).toThrow(CmsPolicyError);
    });
  });

  // Every class of character `branch-policy.ts` refuses, asserted through this function so that
  // a slug an editor could realistically produce cannot become a branch name git would reject
  // only at push time. The space case is the live one: a collection configured with
  // `slug: "{{title}}"` yields "Leave policy".
  describe('refuses a slug git could not use as a ref', () => {
    const cases: readonly [string, string][] = [
      ['a space', 'leave policy'],
      ['a tilde', 'leave~policy'],
      ['a caret', 'leave^policy'],
      ['a colon', 'leave:policy'],
      ['a question mark', 'leave?policy'],
      ['an asterisk', 'leave*policy'],
      ['an open bracket', 'leave[policy'],
      ['a backslash', 'leave\\policy'],
      ['a traversal', 'leave/../policy'],
      ['a doubled slash', 'leave//policy'],
      ['a trailing slash', 'leave-policy/'],
      ['a .lock suffix', 'leave-policy.lock'],
      ['a ref-log expression', 'leave-policy@{1}'],
      ['a dot-leading segment', '.hidden'],
      ['a dot-leading nested segment', 'guides/.hidden'],
      ['a control character', 'leave\u0001policy'],
    ];

    it.each(cases)('%s', (_case, slug) => {
      expect(() => branchForEntry({ collection: 'guides', slug }, SETTINGS)).toThrow(
        CmsPolicyError,
      );
    });
  });

  it('refuses an entry that would name the default branch', () => {
    expect(() =>
      branchForEntry({ collection: 'guides', slug: 'pricing' }, { ...SETTINGS, branchPrefix: '' }),
    ).toThrow(CmsPolicyError);
  });

  it('reports the entry in the refusal, not just the branch', () => {
    expect(() => branchForEntry({ collection: 'guides', slug: 'leave policy' }, SETTINGS)).toThrow(
      /guides\/leave policy/,
    );
  });
});

describe('parseEntryBranch', () => {
  it('recovers the collection and slug', () => {
    expect(parseEntryBranch('cms/guides/leave-policy', 'cms/')).toEqual({
      collection: 'guides',
      slug: 'leave-policy',
    });
  });

  it('gives the whole remainder to the slug', () => {
    expect(parseEntryBranch('cms/adr/2026/0015-decap', 'cms/')).toEqual({
      collection: 'adr',
      slug: '2026/0015-decap',
    });
  });

  it('normalises a prefix configured without a trailing slash', () => {
    expect(parseEntryBranch('cms/guides/pricing', 'cms')).toEqual({
      collection: 'guides',
      slug: 'pricing',
    });
  });

  describe('answers undefined for', () => {
    const cases: readonly [string, string, string][] = [
      ['a branch outside the prefix', 'release/2026-08', 'cms/'],
      ['a sibling prefix', 'cms-internal/guides/pricing', 'cms/'],
      ['the prefix alone', 'cms/', 'cms/'],
      ['a branch with no collection separator', 'cms/pricing', 'cms/'],
      ['an empty collection', 'cms//pricing', 'cms/'],
      ['an empty slug', 'cms/guides/', 'cms/'],
      ['an empty prefix', 'cms/guides/pricing', ''],
    ];

    it.each(cases)('%s', (_case, branch, prefix) => {
      expect(parseEntryBranch(branch, prefix)).toBeUndefined();
    });
  });
});

// The branch name is the only record of which entry a draft holds, so a name that cannot be read
// back is a draft the editorial board would lose track of.
describe('round trip', () => {
  const cases: readonly EntryRef[] = [
    { collection: 'guides', slug: 'leave-policy' },
    { collection: 'adr', slug: '2026/0015-decap' },
    { collection: 'docs', slug: 'a-b_c.1' },
    { collection: 'guides', slug: 'review#1' },
  ];

  it.each(cases)('$collection/$slug', (entry) => {
    const branch = branchForEntry(entry, SETTINGS);

    expect(parseEntryBranch(branch, SETTINGS.branchPrefix)).toEqual(entry);
  });
});
