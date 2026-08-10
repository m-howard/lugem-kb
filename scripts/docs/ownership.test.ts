import { describe, expect, it } from 'vitest';

import { parseCodeowners } from './codeowners';
import { checkOwnership } from './ownership';

describe('checkOwnership', () => {
  const rules = parseCodeowners('/docs/ @docs-team\n/docs/adr/ @platform\n');

  it('accepts pages a rule covers', () => {
    expect(checkOwnership(['docs/leave.md', 'docs/adr/0001-x.md'], rules)).toEqual([]);
  });

  it('reports a page no rule matches', () => {
    const problems = checkOwnership(['guides/leave.md'], rules);

    expect(problems).toHaveLength(1);
    expect(problems[0]?.rule).toBe('ownership-unowned');
    expect(problems[0]?.file).toBe('guides/leave.md');
  });

  // In GitHub's format a pattern with no owners deliberately disowns the path, and it overrides
  // anything earlier. A page that lands there routes to nobody, which is exactly the failure.
  it('reports a page a later rule disowns', () => {
    const disowning = parseCodeowners('/docs/ @docs-team\n/docs/scratch/\n');

    expect(checkOwnership(['docs/scratch/notes.md'], disowning).map((p) => p.rule)).toEqual([
      'ownership-unowned',
    ]);
  });

  it('reports every unowned page', () => {
    const problems = checkOwnership(['a.md', 'b.md', 'docs/ok.md'], rules);

    expect(problems.map((problem) => problem.file)).toEqual(['a.md', 'b.md']);
  });

  it('reports nothing when there are no pages', () => {
    expect(checkOwnership([], rules)).toEqual([]);
  });
});
