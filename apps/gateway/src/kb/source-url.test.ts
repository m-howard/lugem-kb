import { describe, expect, it } from 'vitest';

import { resolveSourceUrl } from './source-url';

const LOCATION = { bucket: 'lugem-corpus', prefix: 'docs/' };

describe('resolveSourceUrl', () => {
  it.each([
    ['a nested page', 'docs/adr/0005-x.md', { path: 'adr/0005-x.md', url: '/adr/0005-x' }],
    [
      'a top-level page',
      'docs/getting-started.md',
      { path: 'getting-started.md', url: '/getting-started' },
    ],
    ['an mdx page', 'docs/guides/setup.mdx', { path: 'guides/setup.mdx', url: '/guides/setup' }],
    ['a deeply nested page', 'docs/a/b/c/d.md', { path: 'a/b/c/d.md', url: '/a/b/c/d' }],
  ])('maps %s', (_case, key, expected) => {
    expect(resolveSourceUrl(`s3://lugem-corpus/${key}`, LOCATION)).toEqual(expected);
  });

  // Docusaurus resolves a folder's index page to the folder's own route, so a citation to
  // docs/index.md must link to `/` and not to a `/index` page that does not exist. The site
  // build would not catch this — nothing links to these URLs at build time.
  describe('index pages resolve to their folder', () => {
    it.each([
      ['the corpus root', 'docs/index.md', { path: 'index.md', url: '/' }],
      ['a subfolder', 'docs/adr/index.md', { path: 'adr/index.md', url: '/adr' }],
      [
        'README, which Docusaurus treats the same way',
        'docs/adr/README.md',
        { path: 'adr/README.md', url: '/adr' },
      ],
    ])('maps %s', (_case, key, expected) => {
      expect(resolveSourceUrl(`s3://lugem-corpus/${key}`, LOCATION)).toEqual(expected);
    });
  });

  it('accepts an extension in any case', () => {
    expect(resolveSourceUrl('s3://lugem-corpus/docs/Loud.MD', LOCATION)).toEqual({
      path: 'Loud.MD',
      url: '/Loud',
    });
  });

  it.each([
    ['prefix without a trailing slash', 'docs'],
    ['prefix with a leading slash', '/docs/'],
    ['prefix with repeated slashes', 'docs//'],
  ])('normalises the %s', (_case, prefix) => {
    expect(
      resolveSourceUrl('s3://lugem-corpus/docs/adr/0005-x.md', { ...LOCATION, prefix }),
    ).toEqual({ path: 'adr/0005-x.md', url: '/adr/0005-x' });
  });

  // Returning undefined rather than a guess. The caller keeps the citation and renders it
  // unlinked — a passage you cannot link is still evidence, but a link to a page that does not
  // exist is worse than no link at all.
  describe('refuses a URI that is not ours', () => {
    it.each([
      ['another bucket', 's3://someone-elses-bucket/docs/adr/0005-x.md'],
      // The directory-boundary rule key-policy.ts enforces on the way in, enforced again on the
      // way out: `docs` must not match `docs-internal/`.
      ['a sibling prefix that shares a name', 's3://lugem-corpus/docs-internal/secret.md'],
      ['a path outside the prefix entirely', 's3://lugem-corpus/.github/workflows/ci.yml'],
      ['a non-markdown extension', 's3://lugem-corpus/docs/diagram.png'],
      ['no extension at all', 's3://lugem-corpus/docs/CODEOWNERS'],
      ['an extension that merely contains md', 's3://lugem-corpus/docs/notes.mdown'],
      ['nothing after the prefix', 's3://lugem-corpus/docs/'],
      ['an https URL', 'https://lugem-corpus.s3.amazonaws.com/docs/adr/0005-x.md'],
      ['an empty string', ''],
      ['a bucket that is a prefix of ours', 's3://lugem-corpus-staging/docs/adr/0005-x.md'],
    ])('refuses %s', (_case, uri) => {
      expect(resolveSourceUrl(uri, LOCATION)).toBeUndefined();
    });
  });

  it('handles an empty prefix, where every key is in the corpus', () => {
    expect(
      resolveSourceUrl('s3://lugem-corpus/adr/0005-x.md', { ...LOCATION, prefix: '' }),
    ).toEqual({ path: 'adr/0005-x.md', url: '/adr/0005-x' });
  });
});
