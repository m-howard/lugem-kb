import { describe, expect, it } from 'vitest';

import { type FolderQuery, selectsPath, toImplementationEntry } from './entries';

describe('selectsPath', () => {
  describe('accepts', () => {
    const cases: readonly [string, string, FolderQuery][] = [
      ['a file directly in the folder', 'docs/guides/leave.md', { folder: 'docs/guides' }],
      [
        'a folder written with a trailing slash',
        'docs/guides/leave.md',
        { folder: 'docs/guides/' },
      ],
      ['an empty folder, meaning the whole corpus', 'docs/index.md', { folder: '' }],
      [
        'a matching extension without a dot',
        'docs/guides/leave.md',
        { folder: 'docs/guides', extension: 'md' },
      ],
      [
        'a matching extension with a dot',
        'docs/guides/leave.md',
        { folder: 'docs/guides', extension: '.md' },
      ],
      [
        'an extension in a different case',
        'docs/guides/LEAVE.MD',
        { folder: 'docs/guides', extension: 'md' },
      ],
      [
        'a file at exactly the permitted depth',
        'docs/guides/leave.md',
        { folder: 'docs', depth: 2 },
      ],
      ['a nested file when depth is unset', 'docs/a/b/c.md', { folder: 'docs' }],
    ];

    it.each(cases)('%s', (_case, path, query) => {
      expect(selectsPath(path, query)).toBe(true);
    });
  });

  describe('rejects', () => {
    const cases: readonly [string, string, FolderQuery][] = [
      ['a file outside the folder', 'docs/adr/0001.md', { folder: 'docs/guides' }],
      // The folder is a directory boundary, exactly as the corpus prefix is: `docs/guides-internal`
      // is a different collection, not a deeper part of this one.
      [
        'a sibling folder sharing a name prefix',
        'docs/guides-internal/x.md',
        { folder: 'docs/guides' },
      ],
      ['the folder itself', 'docs/guides/', { folder: 'docs/guides' }],
      [
        'a different extension',
        'docs/guides/leave.mdx',
        { folder: 'docs/guides', extension: 'md' },
      ],
      ['a file deeper than the permitted depth', 'docs/a/b/c.md', { folder: 'docs', depth: 2 }],
    ];

    it.each(cases)('%s', (_case, path, query) => {
      expect(selectsPath(path, query)).toBe(false);
    });
  });

  it('ignores an empty extension rather than matching nothing', () => {
    expect(selectsPath('docs/guides/leave.md', { folder: 'docs/guides', extension: '' })).toBe(
      true,
    );
  });
});

describe('toImplementationEntry', () => {
  it('carries the blob sha as the entry id', () => {
    expect(
      toImplementationEntry({
        branch: 'main',
        path: 'docs/index.md',
        sha: 'blob-1',
        size: 12,
        content: '# Hello\n',
      }),
    ).toEqual({ data: '# Hello\n', file: { path: 'docs/index.md', id: 'blob-1' } });
  });
});
