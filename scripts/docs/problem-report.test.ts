import { describe, expect, it } from 'vitest';

import { type Problem } from './problem';
import { formatAnnotations, formatMarkdown, formatText } from './problem-report';

const CONTEXT = { pageCount: 25 };

const PROBLEMS: Problem[] = [
  {
    file: 'docs/leave.md',
    line: 3,
    rule: 'frontmatter-required-field',
    message: 'Add `owner` to this page’s frontmatter.',
  },
  {
    file: 'docs/adr/0001-x.md',
    line: 12,
    rule: 'link-target',
    message: '"./nope.md" does not resolve to a page in the corpus.',
  },
  {
    file: 'docs/leave.md',
    line: 1,
    rule: 'ownership-unowned',
    message: 'No CODEOWNERS entry matches this page.',
  },
];

describe('formatText', () => {
  it('says what it checked when nothing is wrong', () => {
    expect(formatText([], CONTEXT)).toBe('Checked 25 pages. No problems found.');
  });

  it('leads with the count, because that is what the reader needs first', () => {
    expect(formatText(PROBLEMS, CONTEXT).split('\n')[0]).toBe('3 problems in 2 pages:');
  });

  it('groups by file and orders by line within a file', () => {
    const report = formatText(PROBLEMS, CONTEXT);
    const lines = report.split('\n').filter((line) => line !== '');

    expect(lines[1]).toBe('docs/adr/0001-x.md');
    expect(lines[3]).toBe('docs/leave.md');
    expect(lines[4]).toContain('ownership-unowned');
    expect(lines[5]).toContain('frontmatter-required-field');
  });

  it('keeps the rule and the message in separate columns', () => {
    expect(formatText([PROBLEMS[0]!], CONTEXT)).toContain('frontmatter-required-field  Add');
  });

  it('agrees with itself about singulars', () => {
    expect(formatText([PROBLEMS[0]!], { pageCount: 1 })).toContain('1 problem in 1 page');
  });
});

describe('formatAnnotations', () => {
  it('emits one annotation per problem, pinned to its line', () => {
    expect(formatAnnotations([PROBLEMS[1]!])).toBe(
      '::error file=docs/adr/0001-x.md,line=12,title=link-target::' +
        '"./nope.md" does not resolve to a page in the corpus.',
    );
  });

  // A literal newline ends the annotation, silently truncating everything after it.
  it('escapes a newline inside a message', () => {
    const annotation = formatAnnotations([
      { file: 'docs/a.md', line: 1, rule: 'link-target', message: 'first\nsecond' },
    ]);

    expect(annotation).toContain('first%0Asecond');
    expect(annotation.split('\n')).toHaveLength(1);
  });

  it('emits nothing for a clean run', () => {
    expect(formatAnnotations([])).toBe('');
  });
});

describe('formatMarkdown', () => {
  it('renders a body for a clean run, so a stale failure comment can be corrected', () => {
    const body = formatMarkdown([], CONTEXT);

    expect(body).toContain('### Documentation checks passed');
    expect(body).toContain('Checked 25 pages');
  });

  it('renders one table row per problem', () => {
    const rows = formatMarkdown(PROBLEMS, CONTEXT)
      .split('\n')
      .filter((line) => line.startsWith('| `'));

    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('`docs/adr/0001-x.md`');
  });

  it('escapes a pipe so it cannot split the row', () => {
    const body = formatMarkdown(
      [{ file: 'docs/a.md', line: 1, rule: 'link-target', message: 'a | b' }],
      CONTEXT,
    );

    expect(body).toContain('a \\| b');
  });
});
