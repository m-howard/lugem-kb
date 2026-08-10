#!/usr/bin/env bun
/**
 * Reports what the documentation is missing.
 *
 * Reads the gap feedback table — questions the corpus could not answer, and answers readers marked
 * unhelpful — groups them, attributes each to a documentation area through CODEOWNERS, and keeps a
 * single rolling GitHub issue up to date. That is requirements.md R23's "a gap arrives as an
 * authoring task rather than an undirected backlog item".
 *
 * One issue, updated in place, rather than one per run: a weekly pile of issues is a thing people
 * stop reading by the third week.
 *
 * Usage:
 *   GAP_FEEDBACK_TABLE=... GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/name bun run gaps:report
 *   ... --dry-run    # read and render, touch nothing on GitHub
 */
import { readFile } from 'node:fs/promises';

import { type AttributeValue, DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';

import { type CodeownersRule, ownersFor, parseCodeowners } from './codeowners';

const DOCS_ROOT = 'docs';
const CODEOWNERS_PATH = '.github/CODEOWNERS';
const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_LABEL = 'documentation-gap';
const ISSUE_TITLE = 'Documentation gaps — rolling report';
const ISSUE_MARKER = '<!-- lugem-gap-report -->';
const GITHUB_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const MS_PER_DAY = 86_400_000;
const MAX_QUESTION_DISPLAY = 140;
const UNPROCESSABLE = 422;
const EXIT_FAILURE = 1;

interface ReportConfig {
  readonly table: string;
  readonly region: string;
  readonly windowDays: number;
  readonly label: string;
  readonly token: string;
  readonly repository: string;
  readonly dryRun: boolean;
}

interface GapItem {
  readonly kind: string;
  readonly question: string;
  readonly nearestPath: string | undefined;
  readonly nearestScore: number | undefined;
  readonly citedPaths: readonly string[];
  readonly reason: string | undefined;
}

interface GapGroup {
  readonly question: string;
  count: number;
  path: string | undefined;
  score: number;
  reasons: string[];
}

function readReportConfig(): ReportConfig {
  const dryRun = process.argv.includes('--dry-run');
  const required = dryRun
    ? (['GAP_FEEDBACK_TABLE'] as const)
    : (['GAP_FEEDBACK_TABLE', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY'] as const);
  const missing = required.filter((key) => (process.env[key] ?? '') === '');
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const windowDays = Number(process.env['GAP_REPORT_WINDOW_DAYS'] ?? DEFAULT_WINDOW_DAYS);
  if (!Number.isInteger(windowDays) || windowDays < 1) {
    throw new Error('GAP_REPORT_WINDOW_DAYS must be a whole number of days, 1 or more');
  }

  return {
    table: process.env['GAP_FEEDBACK_TABLE'] ?? '',
    region: process.env['AWS_REGION'] ?? 'us-east-1',
    windowDays,
    label: process.env['GAP_REPORT_ISSUE_LABEL'] ?? DEFAULT_LABEL,
    token: process.env['GITHUB_TOKEN'] ?? '',
    repository: process.env['GITHUB_REPOSITORY'] ?? '',
    dryRun,
  };
}

/** UTC day partitions covering the window, most recent last. */
function daysInWindow(windowDays: number, now: number): string[] {
  const days: string[] = [];
  for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
    days.push(new Date(now - offset * MS_PER_DAY).toISOString().slice(0, 'YYYY-MM-DD'.length));
  }
  return days;
}

function textOf(value: AttributeValue | undefined): string | undefined {
  return value?.S;
}

function toGapItem(item: Record<string, AttributeValue>): GapItem | undefined {
  const question = textOf(item['question']);
  const kind = textOf(item['kind']);
  if (question === undefined || kind === undefined) {
    return undefined;
  }

  const score = item['nearestScore']?.N;
  return {
    kind,
    question,
    nearestPath: textOf(item['nearestPath']),
    nearestScore: score === undefined ? undefined : Number(score),
    citedPaths: (item['citedPaths']?.L ?? [])
      .map((entry) => entry.S)
      .filter((path): path is string => path !== undefined),
    reason: textOf(item['reason']),
  };
}

/**
 * One bounded `Query` per day partition, paginated. Never a `Scan`: cost would scale with what is
 * retained rather than what is asked for, and TTL deletion lags by up to 48 hours — so a scan
 * would read items the retention policy already considers gone.
 */
async function readGaps(client: DynamoDBClient, config: ReportConfig, now: number) {
  const gaps: GapItem[] = [];

  for (const day of daysInWindow(config.windowDays, now)) {
    let startKey: Record<string, AttributeValue> | undefined;

    do {
      const response = await client.send(
        new QueryCommand({
          TableName: config.table,
          KeyConditionExpression: '#day = :day',
          ExpressionAttributeNames: { '#day': 'day' },
          ExpressionAttributeValues: { ':day': { S: day } },
          ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
        }),
      );

      for (const item of response.Items ?? []) {
        const gap = toGapItem(item);
        if (gap !== undefined) {
          gaps.push(gap);
        }
      }
      startKey = response.LastEvaluatedKey;
    } while (startKey !== undefined);
  }

  return gaps;
}

/** Same question asked five different ways is one gap, not five. */
function groupKey(question: string): string {
  return question
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[?.!]+$/, '')
    .trim();
}

function group(gaps: readonly GapItem[], kind: string): GapGroup[] {
  const groups = new Map<string, GapGroup>();

  for (const gap of gaps.filter((candidate) => candidate.kind === kind)) {
    const key = groupKey(gap.question);
    const existing = groups.get(key) ?? {
      question: gap.question,
      count: 0,
      path: undefined,
      score: -1,
      reasons: [],
    };

    existing.count += 1;
    if (gap.reason !== undefined) {
      existing.reasons.push(gap.reason);
    }

    // Attribute to the strongest signal in the group: the best near miss for an unanswered
    // question, or the first cited page for an answer that missed.
    const candidatePath = gap.nearestPath ?? gap.citedPaths[0];
    const candidateScore = gap.nearestScore ?? 0;
    if (candidatePath !== undefined && candidateScore > existing.score) {
      existing.path = candidatePath;
      existing.score = candidateScore;
    }

    groups.set(key, existing);
  }

  return Array.from(groups.values()).sort((left, right) => right.count - left.count);
}

/**
 * Reader text, on its way into an issue a docs lead reads.
 *
 * This is the injection surface of the whole feature: the question is whatever somebody typed into
 * a chat box. Backticks would break out of the code span, a pipe would break the table row, and an
 * `@mention` would notify whoever it names — `@everyone` included.
 */
function escapeForTable(text: string): string {
  const flattened = text
    .replace(/\s+/g, ' ')
    .replace(/`/g, "'")
    .replace(/\|/g, '\\|')
    .replace(/@/g, '@​')
    .trim();

  return flattened.length > MAX_QUESTION_DISPLAY
    ? `${flattened.slice(0, MAX_QUESTION_DISPLAY)}…`
    : flattened;
}

function renderRows(groups: readonly GapGroup[], rules: readonly CodeownersRule[]): string {
  return groups
    .map((entry) => {
      const owners = entry.path === undefined ? [] : ownersFor(`${DOCS_ROOT}/${entry.path}`, rules);
      const where = entry.path === undefined ? '—' : `\`${DOCS_ROOT}/${entry.path}\``;
      const who = owners.length === 0 ? '_unowned_' : owners.join(', ');
      return `| ${String(entry.count)} | \`${escapeForTable(entry.question)}\` | ${where} | ${who} |`;
    })
    .join('\n');
}

interface SectionOptions {
  readonly heading: string;
  readonly groups: readonly GapGroup[];
  readonly rules: readonly CodeownersRule[];
  readonly emptyMessage: string;
}

function renderSection(options: SectionOptions): string {
  if (options.groups.length === 0) {
    return `## ${options.heading}\n\n${options.emptyMessage}\n`;
  }
  return [
    `## ${options.heading}`,
    '',
    '| Count | Question | Nearest page | Owner |',
    '|---|---|---|---|',
    renderRows(options.groups, options.rules),
    '',
  ].join('\n');
}

interface BodyOptions {
  readonly gaps: readonly GapItem[];
  readonly rules: readonly CodeownersRule[];
  readonly windowDays: number;
  readonly now: number;
}

function renderBody(options: BodyOptions): string {
  const { gaps, rules, now } = options;
  const window = `the last ${String(options.windowDays)} day(s)`;

  return [
    ISSUE_MARKER,
    '',
    `Regenerated in full on every run. Questions are readers' own words, recorded only when the`,
    `documentation could not answer them — see \`docs/adr/0015-recording-documentation-gaps.md\`.`,
    '',
    renderSection({
      heading: `Questions with no documentation (${window})`,
      groups: group(gaps, 'no-coverage'),
      rules,
      emptyMessage: 'None. Every question in this window found something.',
    }),
    renderSection({
      heading: `Answers marked unhelpful (${window})`,
      groups: group(gaps, 'unhelpful'),
      rules,
      emptyMessage: 'None reported.',
    }),
    '---',
    '',
    `Generated ${new Date(now).toISOString()} from ${String(gaps.length)} recorded event(s).`,
  ].join('\n');
}

async function callGitHub(
  config: ReportConfig,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': API_VERSION,
      'content-type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

/**
 * Finds the rolling issue by listing, not by search.
 *
 * The search API is eventually consistent, so a run shortly after the issue was opened would not
 * find it and would open a second one.
 */
async function findRollingIssue(config: ReportConfig): Promise<number | undefined> {
  const response = await callGitHub(
    config,
    `/repos/${config.repository}/issues?state=open&labels=${encodeURIComponent(config.label)}&per_page=100`,
  );
  if (!response.ok) {
    throw new Error(`Could not list issues: ${String(response.status)}`);
  }

  const issues = (await response.json()) as { number: number; title: string }[];
  return issues.find((issue) => issue.title === ISSUE_TITLE)?.number;
}

async function ensureLabel(config: ReportConfig): Promise<void> {
  const response = await callGitHub(config, `/repos/${config.repository}/labels`, {
    method: 'POST',
    body: JSON.stringify({
      name: config.label,
      color: 'd4c5f9',
      description: 'Questions readers asked that the documentation could not answer',
    }),
  });

  // 422 is "already exists", which is the expected case on every run after the first.
  if (!response.ok && response.status !== UNPROCESSABLE) {
    throw new Error(`Could not create the label: ${String(response.status)}`);
  }
}

async function publish(config: ReportConfig, body: string, hasGaps: boolean): Promise<void> {
  await ensureLabel(config);
  const existing = await findRollingIssue(config);

  if (existing !== undefined) {
    const response = await callGitHub(
      config,
      `/repos/${config.repository}/issues/${String(existing)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ body }),
      },
    );
    if (!response.ok) {
      throw new Error(`Could not update issue #${String(existing)}: ${String(response.status)}`);
    }
    console.log(`Updated issue #${String(existing)}.`);
    return;
  }

  if (!hasGaps) {
    console.log('No gaps and no existing issue — nothing to open.');
    return;
  }

  const response = await callGitHub(config, `/repos/${config.repository}/issues`, {
    method: 'POST',
    body: JSON.stringify({ title: ISSUE_TITLE, body, labels: [config.label] }),
  });
  if (!response.ok) {
    throw new Error(`Could not open the report issue: ${String(response.status)}`);
  }
  console.log('Opened the rolling gap report.');
}

async function readCodeowners(): Promise<readonly CodeownersRule[]> {
  try {
    return parseCodeowners(await readFile(CODEOWNERS_PATH, 'utf8'));
  } catch {
    // A report with unattributed gaps beats no report at all.
    console.warn(`No ${CODEOWNERS_PATH}; gaps will be reported without an owner.`);
    return [];
  }
}

async function main(): Promise<void> {
  const config = readReportConfig();
  const now = Date.now();

  const gaps = await readGaps(new DynamoDBClient({ region: config.region }), config, now);
  const rules = await readCodeowners();
  const body = renderBody({ gaps, rules, windowDays: config.windowDays, now });

  console.log(
    `${String(gaps.length)} recorded event(s) in the last ${String(config.windowDays)} day(s).`,
  );

  if (config.dryRun) {
    console.log('Dry run — GitHub untouched.\n');
    console.log(body);
    return;
  }

  await publish(config, body, gaps.length > 0);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(EXIT_FAILURE);
}
