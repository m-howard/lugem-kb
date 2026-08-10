import { describe, expect, it } from 'vitest';

import { checkLinks, type CorpusPage, findLinks, headingSlugs } from './links';

function targets(body: string): string[] {
  return findLinks(body).map((link) => link.target);
}

describe('findLinks', () => {
  it('finds an inline link and the line it is on', () => {
    expect(findLinks('Intro\n\nSee [the guide](./getting-started.md).')).toEqual([
      { target: './getting-started.md', line: 3 },
    ]);
  });

  it('finds several links on one line', () => {
    expect(targets('[a](./a.md) and [b](./b.md)')).toEqual(['./a.md', './b.md']);
  });

  it('drops a link title', () => {
    expect(targets('[a](./a.md "The A page")')).toEqual(['./a.md']);
  });

  it('finds a reference definition', () => {
    expect(findLinks('[guide]: ./getting-started.md\n')).toEqual([
      { target: './getting-started.md', line: 1 },
    ]);
  });

  it('reads the outer target of a linked image', () => {
    expect(targets('[![badge](./b.svg)](./target.md)')).toContain('./target.md');
  });

  // Every guide here shows markdown as well as using it. A fenced example is an illustration,
  // not a claim about the corpus.
  it('ignores links inside a fenced code block', () => {
    expect(targets('Real [a](./a.md)\n\n```md\n[fake](./nope.md)\n```\n')).toEqual(['./a.md']);
  });

  it('ignores links inside a tilde fence', () => {
    expect(targets('~~~\n[fake](./nope.md)\n~~~\n')).toEqual([]);
  });

  it('does not let a shorter inner fence close a longer one', () => {
    expect(targets('````\n```\n[fake](./nope.md)\n```\n````\n[real](./a.md)\n')).toEqual([
      './a.md',
    ]);
  });

  it('ignores a link inside an inline code span', () => {
    expect(targets('Write `[a](./nope.md)` like this, then [b](./b.md).')).toEqual(['./b.md']);
  });

  it('keeps line numbers accurate after a code block', () => {
    expect(findLinks('```\nfenced\n```\n[a](./a.md)')).toEqual([{ target: './a.md', line: 4 }]);
  });

  it('finds nothing in a page with no links', () => {
    expect(findLinks('# Title\n\nProse only.\n')).toEqual([]);
  });
});

describe('headingSlugs', () => {
  it('slugifies ATX headings the way Docusaurus does', () => {
    const slugs = headingSlugs('# The CMS GitHub App\n\n## Verify a deployment\n');

    expect([...slugs]).toEqual(['the-cms-github-app', 'verify-a-deployment']);
  });

  it('drops punctuation rather than hyphenating it', () => {
    expect(headingSlugs("## What it won't do\n").has('what-it-wont-do')).toBe(true);
  });

  it('unwraps inline formatting and links', () => {
    expect(headingSlugs('## The **[CMS](./a.md)** app\n').has('the-cms-app')).toBe(true);
  });

  it('suffixes a repeated heading, as the rendered page does', () => {
    const slugs = headingSlugs('## Troubleshooting\n## Troubleshooting\n## Troubleshooting\n');

    expect([...slugs]).toEqual(['troubleshooting', 'troubleshooting-1', 'troubleshooting-2']);
  });

  it('ignores a `#` inside a code block', () => {
    expect(headingSlugs('```sh\n# not a heading\n```\n').size).toBe(0);
  });

  it('ignores a bare `#` with no text', () => {
    expect(headingSlugs('#\n###\n').size).toBe(0);
  });
});

describe('checkLinks', () => {
  const corpus: CorpusPage[] = [
    {
      file: 'docs/index.md',
      body: '# Home\n\n## Getting oriented\n\nSee [start](./getting-started.md#prerequisites).',
    },
    { file: 'docs/getting-started.md', body: '# Start\n\n## Prerequisites\n' },
    { file: 'docs/adr/0004-pulumi.md', body: '# ADR\n\n[up](../getting-started.md)' },
  ];

  it('accepts a corpus whose links all resolve', () => {
    expect(checkLinks(corpus)).toEqual([]);
  });

  it('reports a relative link to a page that does not exist', () => {
    const problems = checkLinks([{ file: 'docs/a.md', body: '[x](./nope.md)' }]);

    expect(problems).toHaveLength(1);
    expect(problems[0]?.rule).toBe('link-target');
    expect(problems[0]?.message).toContain('docs/nope.md');
  });

  it('reports an anchor the target page does not publish', () => {
    const problems = checkLinks([
      { file: 'docs/a.md', body: '[x](./b.md#missing)' },
      { file: 'docs/b.md', body: '## Present\n' },
    ]);

    expect(problems.map((problem) => problem.rule)).toEqual(['link-anchor']);
  });

  it('checks a same-page anchor against the page it is on', () => {
    const problems = checkLinks([
      { file: 'docs/a.md', body: '## What is recorded\n\n[see](#what-is-recorded) [no](#absent)' },
    ]);

    expect(problems.map((problem) => problem.rule)).toEqual(['link-anchor']);
    expect(problems[0]?.message).toContain('#absent');
  });

  it('resolves a link that walks up a directory', () => {
    expect(
      checkLinks(corpus).filter((problem) => problem.file === 'docs/adr/0004-pulumi.md'),
    ).toEqual([]);
  });

  it.each([
    ['an external URL', 'https://example.com/page'],
    ['a mailto', 'mailto:someone@example.com'],
    ['a protocol-relative URL', '//example.com/page'],
    ['a site-absolute path', '/adr/0001-monorepo'],
  ])('skips %s', (_case, target) => {
    expect(checkLinks([{ file: 'docs/a.md', body: `[x](${target})` }])).toEqual([]);
  });

  // The corpus is markdown only. A relative link to anything else is Docusaurus's business, and
  // failing it here would be this checker guessing at asset handling it does not model.
  it('skips a relative link to a non-markdown file', () => {
    expect(checkLinks([{ file: 'docs/a.md', body: '[x](./diagram.svg)' }])).toEqual([]);
  });

  it('reports the line the broken link is on', () => {
    const problems = checkLinks([{ file: 'docs/a.md', body: '# T\n\n\n[x](./nope.md)' }]);

    expect(problems[0]?.line).toBe(4);
  });

  it('finds problems on every page, not only the first', () => {
    const problems = checkLinks([
      { file: 'docs/a.md', body: '[x](./nope.md)' },
      { file: 'docs/b.md', body: '[y](./also-nope.md)' },
    ]);

    expect(problems.map((problem) => problem.file)).toEqual(['docs/a.md', 'docs/b.md']);
  });
});
