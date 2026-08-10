import { describe, expect, it } from 'vitest';

import { parseFrontmatter, validateFrontmatter } from './frontmatter';

const FILE = 'docs/leave.md';

/** A page as an author would write it, and as every page in this corpus actually looks. */
const GOOD_PAGE = `---
title: Leave policy
owner: people
last_reviewed: 2026-08-10
---

# Leave policy
`;

function problemsFor(body: string) {
  return validateFrontmatter(parseFrontmatter(body), { file: FILE });
}

describe('parseFrontmatter', () => {
  it('reads each field with the line it sits on', () => {
    const parsed = parseFrontmatter(GOOD_PAGE);

    expect(parsed.present).toBe(true);
    expect(parsed.fields.get('title')).toEqual({ value: 'Leave policy', line: 2 });
    expect(parsed.fields.get('owner')).toEqual({ value: 'people', line: 3 });
    expect(parsed.fields.get('last_reviewed')).toEqual({ value: '2026-08-10', line: 4 });
  });

  it('reports no block when the file does not start with one', () => {
    expect(parseFrontmatter('# Leave policy\n\n---\n')).toEqual({
      present: false,
      fields: new Map(),
    });
  });

  // A `---` mid-file is a horizontal rule. Treating it as frontmatter would read prose as fields.
  it('ignores a fence that is not the first thing in the file', () => {
    expect(parseFrontmatter('Intro\n\n---\ntitle: Not frontmatter\n---\n').present).toBe(false);
  });

  it('splits on the first colon only', () => {
    const parsed = parseFrontmatter('---\ntitle: 0005 — Bedrock: the sequel\n---\n');

    expect(parsed.fields.get('title')?.value).toBe('0005 — Bedrock: the sequel');
  });

  it('strips matching surrounding quotes', () => {
    const parsed = parseFrontmatter('---\ntitle: "Leave policy"\nowner: \'people\'\n---\n');

    expect(parsed.fields.get('title')?.value).toBe('Leave policy');
    expect(parsed.fields.get('owner')?.value).toBe('people');
  });

  it('reads a field with an empty value as present and empty', () => {
    expect(parseFrontmatter('---\nowner:\n---\n').fields.get('owner')?.value).toBe('');
  });

  // Nested keys and comments are outside what this parser models; claiming to have read them
  // would be worse than skipping them.
  it('skips indented lines and comments', () => {
    const parsed = parseFrontmatter('---\n# a comment: yes\nmeta:\n  path: docs\n---\n');

    expect([...parsed.fields.keys()]).toEqual(['meta']);
  });

  it('handles CRLF line endings', () => {
    expect(parseFrontmatter('---\r\ntitle: Leave\r\n---\r\n').fields.get('title')?.value).toBe(
      'Leave',
    );
  });
});

describe('validateFrontmatter', () => {
  it('accepts a well-formed page', () => {
    expect(problemsFor(GOOD_PAGE)).toEqual([]);
  });

  it('reports the whole block as missing when there is none', () => {
    const problems = problemsFor('# Leave policy\n');

    expect(problems).toHaveLength(1);
    expect(problems[0]?.rule).toBe('frontmatter-missing');
    expect(problems[0]?.line).toBe(1);
  });

  // requirements.md R13 names this case specifically: "a missing owner fails the check".
  it('fails a page with no owner', () => {
    const problems = problemsFor('---\ntitle: Leave\nlast_reviewed: 2026-08-10\n---\n');

    expect(problems).toHaveLength(1);
    expect(problems[0]?.rule).toBe('frontmatter-required-field');
    expect(problems[0]?.message).toContain('owner');
  });

  it('fails a page whose owner is present but empty', () => {
    const problems = problemsFor('---\ntitle: Leave\nowner:\nlast_reviewed: 2026-08-10\n---\n');

    expect(problems.map((problem) => problem.rule)).toEqual(['frontmatter-required-field']);
    expect(problems[0]?.line).toBe(3);
  });

  it('reports every missing field, not only the first', () => {
    expect(problemsFor('---\nsidebar_position: 3\n---\n')).toHaveLength(3);
  });

  it.each([
    ['a non-date', 'yesterday'],
    ['the wrong order', '10-08-2026'],
    ['a day that does not exist', '2026-02-30'],
    ['a month that does not exist', '2026-13-01'],
  ])('rejects last_reviewed that is %s', (_case, value) => {
    const problems = problemsFor(`---\ntitle: L\nowner: people\nlast_reviewed: ${value}\n---\n`);

    expect(problems.map((problem) => problem.rule)).toEqual(['frontmatter-date']);
  });

  it('accepts a leap day that exists', () => {
    expect(problemsFor('---\ntitle: L\nowner: people\nlast_reviewed: 2028-02-29\n---\n')).toEqual(
      [],
    );
  });

  // A missing date is already reported as a missing field; saying it is also malformed would be
  // two problems for one mistake.
  it('does not also report a format problem for an absent date', () => {
    const problems = problemsFor('---\ntitle: L\nowner: people\n---\n');

    expect(problems.map((problem) => problem.rule)).toEqual(['frontmatter-required-field']);
  });

  it('allows the optional keys Docusaurus supports', () => {
    const page = `---
title: Leave policy
owner: people
last_reviewed: 2026-08-10
slug: /leave
sidebar_position: 4
hide_table_of_contents: true
---
`;

    expect(problemsFor(page)).toEqual([]);
  });
});
