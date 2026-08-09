import { describe, expect, it } from 'vitest';

import { type KeyPolicyViolation, resolveDocumentKey, resolveDocumentKeys } from './key-policy';

const PREFIX = 'docs/';

describe('resolveDocumentKey', () => {
  describe('permits', () => {
    it.each([
      ['a file at the prefix root', 'index.md', 'docs/index.md'],
      ['a nested file', 'adr/0001-monorepo.md', 'docs/adr/0001-monorepo.md'],
      ['an mdx file', 'guides/setup.mdx', 'docs/guides/setup.mdx'],
      ['an uppercase extension', 'README.MD', 'docs/README.MD'],
      ['a name containing dots', 'v1.2.3-notes.md', 'docs/v1.2.3-notes.md'],
      ['a name starting with a dot', '.hidden.md', 'docs/.hidden.md'],
    ])('%s', (_case, input, expected) => {
      const result = resolveDocumentKey(input, { prefix: PREFIX });
      expect(result).toEqual({ ok: true, key: expected });
    });
  });

  // Each row below is an acceptance criterion from requirements.md R3. They are asserted here,
  // as pure function calls, precisely because the alternative is asserting them against a live
  // S3 bucket — where a regression means data has already moved.
  describe('refuses', () => {
    const cases: readonly [string, string, KeyPolicyViolation][] = [
      ['an empty path', '', 'empty-path'],
      ['whitespace only', '   ', 'empty-path'],
      ['a null byte', 'index\0.md', 'null-byte'],
      ['a null byte mid-path', 'a\0b/index.md', 'null-byte'],
      ['a backslash', 'adr\\0001.md', 'backslash'],
      ['a windows-style path', '..\\..\\etc\\passwd.md', 'backslash'],
      ['an absolute path', '/etc/passwd.md', 'absolute-path'],
      ['an empty segment', 'adr//0001.md', 'empty-segment'],
      ['a trailing slash', 'adr/', 'empty-segment'],
      ['parent traversal', '../secrets.md', 'traversal'],
      ['nested parent traversal', 'adr/../../secrets.md', 'traversal'],
      ['traversal into CI config', '../.github/workflows/ci.md', 'traversal'],
      ['a current-directory segment', './index.md', 'traversal'],
      ['a yaml file', 'config.yaml', 'extension'],
      ['a workflow file', 'ci.yml', 'extension'],
      ['an extensionless path', 'index', 'extension'],
      ['a markdown-lookalike', 'evil.md.sh', 'extension'],
      ['a file with no extension inside the tree', 'adr/README', 'extension'],
    ];

    it.each(cases)('%s', (_case, input, reason) => {
      const result = resolveDocumentKey(input, { prefix: PREFIX });
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ reason });
    });

    it('refuses traversal before checking the extension, so the reason names the real problem', () => {
      const result = resolveDocumentKey('../../.github/workflows/ci.yml', { prefix: PREFIX });
      expect(result).toMatchObject({ reason: 'traversal' });
    });
  });

  describe('prefix handling', () => {
    it('accepts a prefix without a trailing slash', () => {
      expect(resolveDocumentKey('index.md', { prefix: 'docs' })).toEqual({
        ok: true,
        key: 'docs/index.md',
      });
    });

    it('accepts a prefix with a leading slash', () => {
      expect(resolveDocumentKey('index.md', { prefix: '/docs/' })).toEqual({
        ok: true,
        key: 'docs/index.md',
      });
    });

    it('supports an empty prefix, keying at the bucket root', () => {
      expect(resolveDocumentKey('index.md', { prefix: '' })).toEqual({
        ok: true,
        key: 'index.md',
      });
    });

    // `docs` must not be able to reach `docs-internal/`: the prefix is a directory boundary,
    // not a string prefix.
    it('does not let a sibling directory be reached by name', () => {
      const result = resolveDocumentKey('index.md', { prefix: 'docs' });
      expect(result).toEqual({ ok: true, key: 'docs/index.md' });
      expect(result.ok && result.key.startsWith('docs-internal')).toBe(false);
    });
  });
});

describe('resolveDocumentKeys', () => {
  it('resolves every path when all are permitted', () => {
    const result = resolveDocumentKeys(['a.md', 'b/c.md'], { prefix: PREFIX });
    expect(result).toEqual({ ok: true, keys: ['docs/a.md', 'docs/b/c.md'] });
  });

  // R3: "Multi-file tree writes are refused if any entry violates policy." A batch that applied
  // its valid entries and dropped the rest would be a partial application, which is the outcome
  // the requirement exists to prevent.
  it('refuses the whole batch when one entry violates policy', () => {
    const result = resolveDocumentKeys(['a.md', '../escape.md', 'b.md'], { prefix: PREFIX });
    expect(result).toMatchObject({ ok: false, reason: 'traversal' });
  });

  it('reports the first violation, not the last', () => {
    const result = resolveDocumentKeys(['bad.yaml', '../worse.md'], { prefix: PREFIX });
    expect(result).toMatchObject({ ok: false, reason: 'extension' });
  });

  it('accepts an empty batch', () => {
    expect(resolveDocumentKeys([], { prefix: PREFIX })).toEqual({ ok: true, keys: [] });
  });
});
