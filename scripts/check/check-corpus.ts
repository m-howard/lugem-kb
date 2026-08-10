#!/usr/bin/env bun
/**
 * The content quality gates — requirements.md R13.
 *
 * Three checks over every page in the corpus, in one pass:
 *
 *   - Frontmatter carries `title`, `owner` and a real `last_reviewed` date.
 *   - Every page's path matches a `.github/CODEOWNERS` entry, so a review request routes somewhere.
 *   - Every relative markdown link and `#anchor` resolves.
 *
 * Docusaurus already fails its build on a broken link, and that safety net stays. This exists for
 * R13's third criterion — "failures surface as a readable message, not a raw log" — and because it
 * runs in seconds without building the site, so an author submitting through `/admin` learns what
 * is wrong from a comment on their own pull request rather than from a stack trace in a log they
 * have no reason to open.
 *
 * Usage:
 *   bun run docs:check
 *   ... --github     # also emit ::error annotations, pinned to the line in the diff
 *   ... --markdown   # emit the pull request comment body instead of the terminal report
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseCodeowners } from '../docs/codeowners';
import { findMarkdownFiles } from '../docs/corpus-files';
import { parseFrontmatter, validateFrontmatter } from '../docs/frontmatter';
import { checkLinks, type CorpusPage } from '../docs/links';
import { checkOwnership } from '../docs/ownership';
import { type Problem } from '../docs/problem';
import { formatAnnotations, formatMarkdown, formatText } from '../docs/problem-report';

const DOCS_ROOT = 'docs';
const CODEOWNERS_PATH = '.github/CODEOWNERS';
const EXIT_FAILURE = 1;

/** Reads every corpus page, keyed by its repository-root-relative path. */
async function readCorpus(): Promise<readonly CorpusPage[]> {
  const files = await findMarkdownFiles(DOCS_ROOT);

  return Promise.all(
    files.map(async (file) => ({
      file: `${DOCS_ROOT}/${file}`,
      body: await readFile(join(DOCS_ROOT, file), 'utf8'),
    })),
  );
}

/**
 * A missing CODEOWNERS file is not a failure.
 *
 * A fork or a fresh clone may not have one, and refusing to run the other two checks because of it
 * would make the gate less useful exactly where it is most needed.
 */
async function readCodeowners(): Promise<string> {
  try {
    return await readFile(CODEOWNERS_PATH, 'utf8');
  } catch {
    console.warn(`No ${CODEOWNERS_PATH}; skipping the ownership check.`);
    return '';
  }
}

async function collectProblems(pages: readonly CorpusPage[]): Promise<readonly Problem[]> {
  const rules = parseCodeowners(await readCodeowners());

  return [
    ...pages.flatMap((page) =>
      validateFrontmatter(parseFrontmatter(page.body), { file: page.file }),
    ),
    ...checkOwnership(
      pages.map((page) => page.file),
      rules,
    ),
    ...checkLinks(pages),
  ];
}

async function main(): Promise<void> {
  const pages = await readCorpus();
  const problems = await collectProblems(pages);
  const context = { pageCount: pages.length };

  console.log(
    process.argv.includes('--markdown')
      ? formatMarkdown(problems, context)
      : formatText(problems, context),
  );

  if (problems.length > 0 && process.argv.includes('--github')) {
    console.log(formatAnnotations(problems));
  }

  if (problems.length > 0) {
    process.exit(EXIT_FAILURE);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(EXIT_FAILURE);
}
