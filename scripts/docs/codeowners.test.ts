import { describe, expect, it } from 'vitest';

import { ownersFor, parseCodeowners } from './codeowners';

/** This repository's own file, trimmed to the entries the report actually exercises. */
const REPO_FILE = `
# Every documentation page carries an \`owner\` in frontmatter.

*                       @m-howard

/docs/                  @m-howard
/docs/adr/              @m-howard

/apps/gateway/src/auth/                @m-howard
/package.json           @m-howard
`;

describe('parseCodeowners', () => {
  it('drops comments and blank lines', () => {
    expect(parseCodeowners(REPO_FILE)).toEqual([
      { pattern: '*', owners: ['@m-howard'] },
      { pattern: '/docs/', owners: ['@m-howard'] },
      { pattern: '/docs/adr/', owners: ['@m-howard'] },
      { pattern: '/apps/gateway/src/auth/', owners: ['@m-howard'] },
      { pattern: '/package.json', owners: ['@m-howard'] },
    ]);
  });

  it('reads every owner on a line, not just the first', () => {
    const rules = parseCodeowners('/docs/ @docs-team @platform  @someone\n');

    expect(rules[0]?.owners).toEqual(['@docs-team', '@platform', '@someone']);
  });

  it('strips a trailing comment from an entry', () => {
    expect(parseCodeowners('/docs/ @docs-team # the corpus\n')[0]).toEqual({
      pattern: '/docs/',
      owners: ['@docs-team'],
    });
  });

  // In GitHub's format this deliberately means "this path has no owner", and it overrides
  // anything earlier. Dropping the line would silently restore the broader rule.
  it('keeps a pattern with no owners', () => {
    expect(parseCodeowners('/docs/scratch/\n')[0]).toEqual({
      pattern: '/docs/scratch/',
      owners: [],
    });
  });
});

describe('ownersFor', () => {
  const rules = parseCodeowners(REPO_FILE);

  it.each([
    ['a corpus page', 'docs/people/leave.md'],
    ['a nested corpus page', 'docs/a/b/c/deep.md'],
    ['the catch-all', 'README.md'],
    ['an exact file entry', 'package.json'],
    ['a directory entry', 'apps/gateway/src/auth/middleware.ts'],
  ])('resolves %s', (_case, path) => {
    expect(ownersFor(path, rules)).toEqual(['@m-howard']);
  });

  // THE test. `/docs/` and `/docs/adr/` both match an ADR, and only the later entry names the
  // team that should actually hear about a gap there. Getting this backwards is the single most
  // common way a CODEOWNERS implementation is wrong, and it fails silently.
  it('takes the last matching rule, not the first', () => {
    const specific = parseCodeowners('*  @everyone\n/docs/  @docs-team\n/docs/adr/  @architects\n');

    expect(ownersFor('docs/adr/0006-x.md', specific)).toEqual(['@architects']);
    expect(ownersFor('docs/people/leave.md', specific)).toEqual(['@docs-team']);
    expect(ownersFor('README.md', specific)).toEqual(['@everyone']);
  });

  it('lets a later rule disown a path', () => {
    const rulesWithHole = parseCodeowners('*  @everyone\n/docs/scratch/\n');

    expect(ownersFor('docs/scratch/notes.md', rulesWithHole)).toEqual([]);
  });

  it('returns nothing when no rule matches, so the report can say so', () => {
    expect(ownersFor('docs/people/leave.md', parseCodeowners('/infra/  @platform\n'))).toEqual([]);
  });

  it('anchors a leading slash at the repository root', () => {
    const anchored = parseCodeowners('/docs/  @docs-team\n');

    expect(ownersFor('docs/a.md', anchored)).toEqual(['@docs-team']);
    expect(ownersFor('apps/docs/a.md', anchored)).toEqual([]);
  });

  it('matches an unanchored pattern at any depth', () => {
    const unanchored = parseCodeowners('build/  @platform\n');

    expect(ownersFor('build/out.js', unanchored)).toEqual(['@platform']);
    expect(ownersFor('apps/docs/build/out.js', unanchored)).toEqual(['@platform']);
  });

  it('keeps a single star inside one path segment', () => {
    const starred = parseCodeowners('/docs/*.md  @docs-team\n');

    expect(ownersFor('docs/index.md', starred)).toEqual(['@docs-team']);
    expect(ownersFor('docs/adr/0006.md', starred)).toEqual([]);
  });

  it('lets a double star cross path segments', () => {
    const starred = parseCodeowners('/docs/**/*.md  @docs-team\n');

    expect(ownersFor('docs/adr/0006.md', starred)).toEqual(['@docs-team']);
  });

  // Nothing in this repository uses these, and a near-miss would file a gap against the wrong
  // team — which is worse than filing it against nobody.
  it.each([
    ['a question mark', '/docs/?.md'],
    ['a character class', '/docs/[ab].md'],
  ])('refuses to guess at %s', (_case, pattern) => {
    expect(ownersFor('docs/a.md', parseCodeowners(`${pattern}  @docs-team\n`))).toEqual([]);
  });

  it('tolerates a leading slash on the looked-up path', () => {
    expect(ownersFor('/docs/people/leave.md', rules)).toEqual(['@m-howard']);
  });
});
