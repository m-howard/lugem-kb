import { type Problem } from './problem';

/** Width of the line-number column in the terminal report. Two digits covers a frontmatter block. */
const LINE_COLUMN_WIDTH = 4;
/** Two wider than the longest `QualityRule`, so the message column never butts up against it. */
const RULE_COLUMN_WIDTH = 28;

export interface ReportContext {
  /** How many pages were examined, so a clean run can say what it checked rather than nothing. */
  readonly pageCount: number;
}

function plural(count: number, singular: string): string {
  return `${String(count)} ${singular}${count === 1 ? '' : 's'}`;
}

function byFileThenLine(a: Problem, b: Problem): number {
  return a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file);
}

function groupByFile(problems: readonly Problem[]): Map<string, Problem[]> {
  const grouped = new Map<string, Problem[]>();
  for (const problem of [...problems].sort(byFileThenLine)) {
    const existing = grouped.get(problem.file);
    if (existing === undefined) {
      grouped.set(problem.file, [problem]);
    } else {
      existing.push(problem);
    }
  }
  return grouped;
}

/**
 * The report a person reads in a terminal or a CI log.
 *
 * Grouped by file and led with the summary, because requirements.md R13 asks for "a readable
 * message, not a raw log" — and the first thing an author needs is how much is wrong, not the
 * first thing that is.
 *
 * @param problems - Everything the gates found.
 * @param context - How many pages were checked.
 * @returns The whole report, newline-separated and without a trailing newline.
 *
 * @example
 * ```ts
 * formatText([], { pageCount: 25 });
 * // → 'Checked 25 pages. No problems found.'
 * ```
 */
export function formatText(problems: readonly Problem[], context: ReportContext): string {
  if (problems.length === 0) {
    return `Checked ${plural(context.pageCount, 'page')}. No problems found.`;
  }

  const grouped = groupByFile(problems);
  const lines: string[] = [
    `${plural(problems.length, 'problem')} in ${plural(grouped.size, 'page')}:`,
    '',
  ];

  for (const [file, found] of grouped) {
    lines.push(file);
    for (const problem of found) {
      const line = String(problem.line).padStart(LINE_COLUMN_WIDTH);
      lines.push(`${line}  ${problem.rule.padEnd(RULE_COLUMN_WIDTH)}${problem.message}`);
    }
    lines.push('');
  }

  lines.push(`Checked ${plural(context.pageCount, 'page')}. Fix the above and run again.`);
  return lines.join('\n');
}

/** GitHub reads these off stdout and pins each one to its line in the pull request diff. */
export function formatAnnotations(problems: readonly Problem[]): string {
  return [...problems]
    .sort(byFileThenLine)
    .map(
      (problem) =>
        `::error file=${problem.file},line=${String(problem.line)},title=${problem.rule}::` +
        // A literal newline would end the annotation; GitHub's own escape for one is `%0A`.
        problem.message.replace(/\n/g, '%0A'),
    )
    .join('\n');
}

/**
 * The pull request comment.
 *
 * This is the half of R13's third criterion that matters most. An author who submitted a page
 * through the CMS at `/publisher` has a pull request and no reason to know what GitHub Actions is;
 * a comment on their submission is the only place they will meet the failure.
 *
 * Rendered for a clean run too, so a comment left by an earlier failing push can be updated to say
 * the problems are gone rather than sitting there contradicting a green check.
 *
 * @param problems - Everything the gates found.
 * @param context - How many pages were checked.
 * @returns Markdown, ready to post.
 */
export function formatMarkdown(problems: readonly Problem[], context: ReportContext): string {
  if (problems.length === 0) {
    return [
      '### Documentation checks passed',
      '',
      `Checked ${plural(context.pageCount, 'page')}. Frontmatter, ownership and internal links are all in order.`,
    ].join('\n');
  }

  const lines = [
    '### Documentation checks failed',
    '',
    `${plural(problems.length, 'problem')} to fix before this can be published.`,
    '',
    '| Page | Line | What to fix |',
    '| --- | --- | --- |',
  ];

  for (const problem of [...problems].sort(byFileThenLine)) {
    // Pipes would split the row; nothing else in a message needs escaping in a table cell.
    const message = problem.message.replace(/\|/g, '\\|');
    lines.push(`| \`${problem.file}\` | ${String(problem.line)} | ${message} |`);
  }

  return lines.join('\n');
}
