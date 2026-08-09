import { describe, expect, it } from 'vitest';

import { type PathPolicyViolation, resolveWritePath, resolveWritePaths } from './path-policy';

const PREFIXES = ['docs/'];

describe('resolveWritePath', () => {
  it.each([
    ['a page in the corpus', 'docs/getting-started.md'],
    ['a nested page', 'docs/adr/0013-two-auth-modes.md'],
    ['an MDX page', 'docs/index.mdx'],
  ])('accepts %s', (_case, path) => {
    expect(resolveWritePath(path, { prefixes: PREFIXES })).toEqual({ ok: true, path });
  });

  it('accepts any of several configured prefixes', () => {
    const options = { prefixes: ['docs/', 'handbook/'] };

    expect(resolveWritePath('handbook/leave.md', options)).toMatchObject({ ok: true });
    expect(resolveWritePath('docs/leave.md', options)).toMatchObject({ ok: true });
  });

  // Each row is an acceptance criterion from requirements.md R3. They are asserted as pure
  // function calls because the alternative is asserting them against a real repository — where a
  // regression means the commit has already landed.
  describe('refuses', () => {
    const cases: readonly [string, string, PathPolicyViolation][] = [
      ['a workflow file', '.github/workflows/ci.yml', 'extension'],
      [
        'a markdown file in the workflows directory',
        '.github/workflows/evil.md',
        'outside-prefixes',
      ],
      ['the repository root', 'README.md', 'outside-prefixes'],
      [
        'a sibling directory that starts the same way',
        'docs-internal/secret.md',
        'outside-prefixes',
      ],
      ['traversal out of the docs tree', 'docs/../.github/workflows/ci.md', 'traversal'],
      ['a leading traversal', '../secrets.md', 'traversal'],
      ['an absolute path', '/etc/passwd.md', 'absolute-path'],
      ['a null byte', 'docs/index\0.md', 'null-byte'],
      ['a backslash', 'docs\\index.md', 'backslash'],
      ['an empty segment', 'docs//index.md', 'empty-segment'],
      ['an empty path', '', 'empty-path'],
      ['a shell script inside the docs tree', 'docs/deploy.sh', 'extension'],
      ['a markdown lookalike', 'docs/evil.md.sh', 'extension'],
    ];

    it.each(cases)('%s', (_case, input, reason) => {
      const result = resolveWritePath(input, { prefixes: PREFIXES });

      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ reason });
    });
  });

  // A blank prefix would make `startsWith` true for every path, quietly granting write access to
  // the whole repository. Dropping it has to fail closed, not open.
  it.each([[[]], [['']], [['/']]])('refuses everything when prefixes are %j', (prefixes) => {
    expect(resolveWritePath('docs/index.md', { prefixes })).toMatchObject({
      ok: false,
      reason: 'outside-prefixes',
    });
  });

  it('treats the prefix as a directory boundary however it is written', () => {
    for (const prefix of ['docs', 'docs/', '/docs/']) {
      expect(resolveWritePath('docs/index.md', { prefixes: [prefix] })).toMatchObject({ ok: true });
      expect(resolveWritePath('docsy/index.md', { prefixes: [prefix] })).toMatchObject({
        ok: false,
      });
    }
  });
});

describe('resolveWritePaths', () => {
  it('accepts a change set where every entry is permitted', () => {
    const result = resolveWritePaths(['docs/a.md', 'docs/b.md'], { prefixes: PREFIXES });

    expect(result).toEqual({ ok: true, paths: ['docs/a.md', 'docs/b.md'] });
  });

  // R3: "Multi-file tree writes are refused if any entry violates policy." A batch that applied
  // its good half would leave the repository in a state nobody asked for and no one reviewed.
  it('refuses the whole change set when one entry is not', () => {
    const result = resolveWritePaths(['docs/fine.md', '.github/workflows/ci.yml', 'docs/also.md'], {
      prefixes: PREFIXES,
    });

    expect(result).toMatchObject({ ok: false, reason: 'extension' });
  });

  it('accepts an empty change set without inventing a refusal', () => {
    expect(resolveWritePaths([], { prefixes: PREFIXES })).toEqual({ ok: true, paths: [] });
  });
});
