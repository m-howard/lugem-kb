import { describe, expect, it } from 'vitest';

import { contentKey, resolveEntryRef } from './unpublished';
import { CmsPolicyError } from '../errors';

describe('contentKey', () => {
  it('joins the collection and slug the way Decap spells an id', () => {
    expect(contentKey({ collection: 'guides', slug: 'leave-policy' })).toBe('guides/leave-policy');
  });
});

describe('resolveEntryRef', () => {
  it('takes the pair when both are present', () => {
    expect(resolveEntryRef({ collection: 'guides', slug: 'leave-policy' })).toEqual({
      collection: 'guides',
      slug: 'leave-policy',
    });
  });

  it('splits an id on its first separator', () => {
    expect(resolveEntryRef({ id: 'guides/leave-policy' })).toEqual({
      collection: 'guides',
      slug: 'leave-policy',
    });
  });

  it('gives the whole remainder of an id to the slug', () => {
    expect(resolveEntryRef({ id: 'adr/2026/0015-decap' })).toEqual({
      collection: 'adr',
      slug: '2026/0015-decap',
    });
  });

  // Both spellings reach the same draft, because Decap sends the pair from the entry editor and
  // the joined id from the workflow board. An author's card must not behave differently depending
  // on which screen they opened it from.
  it('agrees with itself across both spellings', () => {
    expect(resolveEntryRef({ id: 'guides/leave-policy' })).toEqual(
      resolveEntryRef({ collection: 'guides', slug: 'leave-policy' }),
    );
  });

  it('prefers the pair when an id disagrees with it', () => {
    expect(resolveEntryRef({ id: 'other/thing', collection: 'guides', slug: 'leave' })).toEqual({
      collection: 'guides',
      slug: 'leave',
    });
  });

  describe('refuses', () => {
    const cases: readonly [string, Record<string, string>][] = [
      ['nothing at all', {}],
      ['a collection with no slug', { collection: 'guides' }],
      ['a slug with no collection', { slug: 'leave-policy' }],
      ['an id with no separator', { id: 'leave-policy' }],
      ['an id with a leading separator', { id: '/leave-policy' }],
      ['an id with a trailing separator', { id: 'guides/' }],
    ];

    it.each(cases)('%s', (_case, params) => {
      expect(() => resolveEntryRef(params)).toThrow(CmsPolicyError);
    });
  });
});
