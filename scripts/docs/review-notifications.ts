#!/usr/bin/env bun
/**
 * Tells the right person that a documentation change needs them.
 *
 * requirements.md R14: owners hear when a pull request awaits their review, and authors hear when
 * their submission is published or has changes requested. Open question Q7 settled on email, so
 * there is no chat platform here — see docs/adr/0020-review-notifications-by-email.md.
 *
 * Runs from GitHub Actions on a webhook delivery. It reads the event, works out who should hear
 * about it, and sends one message through SES. Most deliveries are none of R14's three moments and
 * this exits having done nothing, which is the common path rather than a failure.
 *
 * Usage:
 *   NOTIFY_SENDER=docs@example.com GITHUB_TOKEN=... bun run notify:review
 *   ... --dry-run    # resolve and render, send nothing
 */
import { readFile } from 'node:fs/promises';

import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

import { type CodeownersRule, parseCodeowners } from './codeowners';
import { classifyEvent, type PullRequestEvent } from './notification-event';
import { buildNotification, type NotificationKind } from './notification-message';
import {
  ownerRecipients,
  type OwnerDirectory,
  type RecipientPolicy,
  type Recipients,
  submitterRecipients,
} from './notification-recipients';
import { parseSubmitter } from './submitter-identity';

const CODEOWNERS_PATH = '.github/CODEOWNERS';
const OWNER_DIRECTORY_PATH = '.github/docs-owner-emails.json';
const DEFAULT_CMS_BRANCH_PREFIX = 'cms/';
const GITHUB_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const FILES_PER_PAGE = 100;
const EXIT_FAILURE = 1;

interface NotifyConfig {
  readonly sender: string;
  readonly region: string;
  readonly allowedDomains: readonly string[];
  readonly cmsBranchPrefix: string;
  readonly token: string;
  readonly repository: string;
  readonly eventName: string;
  readonly eventPath: string;
  readonly dryRun: boolean;
}

/**
 * Domains a message may be delivered to.
 *
 * Defaults to the sender's own domain. An operator who needs to reach authors elsewhere sets
 * `NOTIFY_RECIPIENT_DOMAINS` and says so deliberately; the default never mails a stranger.
 */
function resolveAllowedDomains(sender: string): readonly string[] {
  const configured = (process.env['NOTIFY_RECIPIENT_DOMAINS'] ?? '')
    .split(',')
    .map((domain) => domain.trim())
    .filter((domain) => domain !== '');

  if (configured.length > 0) {
    return configured;
  }
  return [sender.split('@')[1] ?? ''];
}

function readNotifyConfig(): NotifyConfig {
  const dryRun = process.argv.includes('--dry-run');
  const required = dryRun
    ? (['NOTIFY_SENDER', 'GITHUB_EVENT_PATH'] as const)
    : (['NOTIFY_SENDER', 'GITHUB_EVENT_PATH', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY'] as const);
  const missing = required.filter((key) => (process.env[key] ?? '') === '');
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const sender = process.env['NOTIFY_SENDER'] ?? '';

  return {
    sender,
    region: process.env['AWS_REGION'] ?? 'us-east-1',
    allowedDomains: resolveAllowedDomains(sender),
    cmsBranchPrefix: process.env['CMS_BRANCH_PREFIX'] ?? DEFAULT_CMS_BRANCH_PREFIX,
    token: process.env['GITHUB_TOKEN'] ?? '',
    repository: process.env['GITHUB_REPOSITORY'] ?? '',
    eventName: process.env['GITHUB_EVENT_NAME'] ?? '',
    eventPath: process.env['GITHUB_EVENT_PATH'] ?? '',
    dryRun,
  };
}

async function readOwnerDirectory(): Promise<OwnerDirectory> {
  try {
    const parsed: unknown = JSON.parse(await readFile(OWNER_DIRECTORY_PATH, 'utf8'));
    const owners = (parsed as { owners?: unknown }).owners;
    return typeof owners === 'object' && owners !== null ? (owners as OwnerDirectory) : {};
  } catch {
    // Not fatal on its own: the run reports every owner it could not place, which is a more useful
    // message than a stack trace about a missing file.
    console.warn(`No usable ${OWNER_DIRECTORY_PATH}; no owner can be routed.`);
    return {};
  }
}

async function readCodeowners(): Promise<readonly CodeownersRule[]> {
  try {
    return parseCodeowners(await readFile(CODEOWNERS_PATH, 'utf8'));
  } catch {
    console.warn(`No ${CODEOWNERS_PATH}; no review request can be routed.`);
    return [];
  }
}

/** The paths a pull request touches, paginated. */
async function readChangedPaths(config: NotifyConfig, number: number): Promise<readonly string[]> {
  const paths: string[] = [];

  for (let page = 1; ; page += 1) {
    const response = await fetch(
      `${GITHUB_API}/repos/${config.repository}/pulls/${String(number)}/files?per_page=${String(FILES_PER_PAGE)}&page=${String(page)}`,
      {
        headers: {
          authorization: `Bearer ${config.token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': API_VERSION,
        },
      },
    );
    if (!response.ok) {
      throw new Error(`Could not list the pull request files: ${String(response.status)}`);
    }

    const files = (await response.json()) as { filename: string }[];
    paths.push(...files.map((file) => file.filename));
    if (files.length < FILES_PER_PAGE) {
      return paths;
    }
  }
}

interface Delivery {
  readonly recipients: Recipients;
  readonly changedPaths: readonly string[];
  readonly submitterName: string | undefined;
}

/**
 * Who hears about this event, and what they need to be told.
 *
 * A review request goes to the owners of the changed pages; the other two go to the author, whose
 * address only exists when the gateway wrote the body on a CMS branch.
 */
async function resolveDelivery(
  kind: NotificationKind,
  config: NotifyConfig,
  payload: PullRequestEvent,
): Promise<Delivery> {
  const pull = payload.pull_request ?? {};
  const submitter = parseSubmitter({
    body: pull.body ?? undefined,
    headRef: pull.head?.ref ?? '',
    cmsBranchPrefix: config.cmsBranchPrefix,
  });

  const policy: RecipientPolicy = {
    rules: await readCodeowners(),
    directory: await readOwnerDirectory(),
    allowedDomains: config.allowedDomains,
  };

  if (kind !== 'review-requested') {
    const recipients =
      submitter === undefined
        ? { to: [], unroutable: [] }
        : submitterRecipients(submitter.email, policy);
    return { recipients, changedPaths: [], submitterName: submitter?.name };
  }

  const changedPaths = await readChangedPaths(config, pull.number ?? 0);
  return {
    recipients: ownerRecipients(changedPaths, policy),
    changedPaths: changedPaths.filter((path) => path.startsWith('docs/')),
    submitterName: submitter?.name,
  };
}

async function send(
  config: NotifyConfig,
  to: readonly string[],
  message: { subject: string; body: string },
): Promise<void> {
  const client = new SESv2Client({ region: config.region });

  // One call per recipient rather than one with many `ToAddresses`: an owner should not learn who
  // else owns the page from a header, and one bad address should not fail the whole delivery.
  for (const address of to) {
    await client.send(
      new SendEmailCommand({
        FromEmailAddress: config.sender,
        Destination: { ToAddresses: [address] },
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: 'UTF-8' },
            Body: { Text: { Data: message.body, Charset: 'UTF-8' } },
          },
        },
      }),
    );
    console.log(`Notified ${address}.`);
  }
}

async function main(): Promise<void> {
  const config = readNotifyConfig();
  const payload = JSON.parse(await readFile(config.eventPath, 'utf8')) as PullRequestEvent;

  const kind = classifyEvent(config.eventName, payload);
  if (kind === undefined) {
    console.log(`Nothing to notify for ${config.eventName}/${payload.action ?? '(no action)'}.`);
    return;
  }

  const pull = payload.pull_request ?? {};
  const delivery = await resolveDelivery(kind, config, payload);

  for (const entry of delivery.recipients.unroutable) {
    console.warn(`::warning::Could not notify ${entry}`);
  }

  if (delivery.recipients.to.length === 0) {
    console.log(
      `No reachable recipient for a ${kind} notification on #${String(pull.number ?? 0)}.`,
    );
    return;
  }

  const message = buildNotification(kind, {
    number: pull.number ?? 0,
    title: pull.title ?? '(untitled)',
    url: pull.html_url ?? '',
    submitterName: delivery.submitterName,
    changedPaths: delivery.changedPaths,
  });

  if (config.dryRun) {
    console.log(`Dry run — would notify ${delivery.recipients.to.join(', ')}.\n`);
    console.log(`Subject: ${message.subject}\n\n${message.body}`);
    return;
  }

  await send(config, delivery.recipients.to, message);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(EXIT_FAILURE);
}
