import { describe, expect, it } from 'vitest';

import { readFrontmatterField } from './frontmatter';

const PAGE = [
  '---',
  'title: 0005 — Bedrock knowledge base on S3 Vectors',
  'sidebar_label: 0005 KB on S3 Vectors',
  'owner: platform',
  'last_reviewed: 2026-08-09',
  '---',
  '',
  '# ADR 0005',
  '',
  '---',
  '',
  'A horizontal rule above, not a second frontmatter block.',
].join('\n');

describe('readFrontmatterField', () => {
  it.each([
    ['last_reviewed', '2026-08-09'],
    ['owner', 'platform'],
    ['sidebar_label', '0005 KB on S3 Vectors'],
  ])('reads %s', (field, expected) => {
    expect(readFrontmatterField(PAGE, field)).toBe(expected);
  });

  it('keeps everything after the first colon, so a value may contain one', () => {
    expect(readFrontmatterField(PAGE, 'title')).toBe('0005 — Bedrock knowledge base on S3 Vectors');
  });

  it('reads a file that uses CRLF line endings', () => {
    expect(readFrontmatterField(PAGE.replace(/\n/g, '\r\n'), 'last_reviewed')).toBe('2026-08-09');
  });

  it.each([
    ['single', "---\ntitle: 'Quoted'\n---\n"],
    ['double', '---\ntitle: "Quoted"\n---\n'],
  ])('strips %s quotes around a value', (_case, body) => {
    expect(readFrontmatterField(body, 'title')).toBe('Quoted');
  });

  it('reads a block that is the entire file, with no trailing newline', () => {
    expect(readFrontmatterField('---\nlast_reviewed: 2026-01-01\n---', 'last_reviewed')).toBe(
      '2026-01-01',
    );
  });

  describe('returns undefined rather than a wrong answer', () => {
    it.each([
      ['the field is absent', PAGE, 'nonexistent'],
      ['there is no frontmatter block', '# Just a heading\n\nSome prose.', 'title'],
      ['the file is empty', '', 'title'],
      ['the block is unterminated', '---\ntitle: Dangling\n\n# Body', 'title'],
      // A rule partway down the file is not frontmatter, no matter what follows it.
      ['the block does not start the file', '# Heading\n\n---\ntitle: Late\n---\n', 'title'],
      ['the key has no value', '---\ntitle:\nowner: platform\n---\n', 'title'],
      ['the line has no colon at all', '---\njust-a-word\n---\n', 'just-a-word'],
      // Documented limitation: nested keys are out of scope for a non-YAML reader. Returning
      // undefined is the honest answer; silently returning '' would read as "reviewed: never".
      ['the value is nested', '---\nreview:\n  last: 2026-08-09\n---\n', 'review'],
    ])('when %s', (_case, body, field) => {
      expect(readFrontmatterField(body, field)).toBeUndefined();
    });

    it('does not match a key that merely ends with the field name', () => {
      expect(readFrontmatterField('---\nnot_title: Wrong\n---\n', 'title')).toBeUndefined();
    });
  });
});
