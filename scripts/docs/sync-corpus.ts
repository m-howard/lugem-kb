#!/usr/bin/env bun
/**
 * Syncs the markdown corpus to S3 and triggers Bedrock ingestion.
 *
 * Pulumi has no resource for "start an ingestion job" — ingestion is an operation, not a piece of
 * infrastructure — so this runs from CI after a merge, and by hand when you want the index caught
 * up now. It implements requirements.md R11 and R21:
 *
 *   - Deleted pages are removed from S3, so retracted content stops being answerable. An
 *     upload-only sync would leave a deleted page in the index indefinitely.
 *   - The ingestion job is polled to a terminal state, so a failed ingestion fails the pipeline
 *     rather than quietly leaving the previous index in place while the site says otherwise.
 *
 * Usage:
 *   CORPUS_BUCKET=... KNOWLEDGE_BASE_ID=... DATA_SOURCE_ID=... bun run corpus:sync
 *   ... --dry-run    # report what would change, touch nothing
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  BedrockAgentClient,
  GetIngestionJobCommand,
  StartIngestionJobCommand,
} from '@aws-sdk/client-bedrock-agent';
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import { findMarkdownFiles } from './corpus-files';

const DOCS_ROOT = 'docs';
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 900_000;
const DELETE_BATCH_SIZE = 1000;
const TERMINAL_STATES = new Set(['COMPLETE', 'FAILED', 'STOPPED']);
const EXIT_FAILURE = 1;

interface SyncConfig {
  readonly bucket: string;
  readonly prefix: string;
  readonly knowledgeBaseId: string;
  readonly dataSourceId: string;
  readonly region: string;
  readonly dryRun: boolean;
}

function readSyncConfig(): SyncConfig {
  const required = ['CORPUS_BUCKET', 'KNOWLEDGE_BASE_ID', 'DATA_SOURCE_ID'] as const;
  const missing = required.filter((key) => (process.env[key] ?? '') === '');
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    bucket: process.env['CORPUS_BUCKET'] ?? '',
    prefix: process.env['CORPUS_PREFIX'] ?? 'docs/',
    knowledgeBaseId: process.env['KNOWLEDGE_BASE_ID'] ?? '',
    dataSourceId: process.env['DATA_SOURCE_ID'] ?? '',
    region: process.env['AWS_REGION'] ?? 'us-east-1',
    dryRun: process.argv.includes('--dry-run'),
  };
}

async function listRemoteKeys(s3: S3Client, config: SyncConfig): Promise<Set<string>> {
  const keys = new Set<string>();
  let continuationToken: string | undefined;

  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: config.prefix,
        ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken }),
      }),
    );
    for (const object of response.Contents ?? []) {
      if (object.Key !== undefined) {
        keys.add(object.Key);
      }
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken !== undefined);

  return keys;
}

async function uploadAll(s3: S3Client, config: SyncConfig, files: string[]): Promise<void> {
  for (const file of files) {
    const body = await readFile(join(DOCS_ROOT, file), 'utf8');
    await s3.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: `${config.prefix}${file}`,
        Body: body,
        ContentType: 'text/markdown; charset=utf-8',
      }),
    );
  }
  console.log(`Uploaded ${String(files.length)} file(s) to s3://${config.bucket}/${config.prefix}`);
}

/** R21: a retracted page must stop being answerable, which means removing it, not just not re-uploading it. */
async function deleteStale(s3: S3Client, config: SyncConfig, stale: string[]): Promise<void> {
  for (let index = 0; index < stale.length; index += DELETE_BATCH_SIZE) {
    const batch = stale.slice(index, index + DELETE_BATCH_SIZE);
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: config.bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })) },
      }),
    );
  }
  console.log(`Deleted ${String(stale.length)} retracted object(s)`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/**
 * Starts ingestion and waits for it to finish.
 *
 * Waiting is the point: returning as soon as the job is accepted would report success for an
 * ingestion that goes on to fail, and the index would silently lag the site.
 */
async function ingest(bedrock: BedrockAgentClient, config: SyncConfig): Promise<void> {
  const started = await bedrock.send(
    new StartIngestionJobCommand({
      knowledgeBaseId: config.knowledgeBaseId,
      dataSourceId: config.dataSourceId,
    }),
  );

  const jobId = started.ingestionJob?.ingestionJobId;
  if (jobId === undefined) {
    throw new Error('Bedrock accepted the ingestion request but returned no job ID.');
  }
  console.log(`Ingestion job ${jobId} started`);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    const job = await bedrock.send(
      new GetIngestionJobCommand({
        knowledgeBaseId: config.knowledgeBaseId,
        dataSourceId: config.dataSourceId,
        ingestionJobId: jobId,
      }),
    );
    const status = job.ingestionJob?.status ?? 'UNKNOWN';

    if (!TERMINAL_STATES.has(status)) {
      continue;
    }
    if (status === 'COMPLETE') {
      console.log(`Ingestion job ${jobId} complete`);
      return;
    }
    const reasons = (job.ingestionJob?.failureReasons ?? []).join('; ');
    throw new Error(`Ingestion job ${jobId} finished as ${status}: ${reasons}`);
  }

  throw new Error(`Ingestion job ${jobId} did not reach a terminal state within the timeout.`);
}

async function main(): Promise<void> {
  const config = readSyncConfig();
  const s3 = new S3Client({ region: config.region });

  const files = await findMarkdownFiles(DOCS_ROOT);
  const localKeys = new Set(files.map((file) => `${config.prefix}${file}`));
  const remoteKeys = await listRemoteKeys(s3, config);
  const stale = [...remoteKeys].filter((key) => !localKeys.has(key));

  console.log(`${String(files.length)} local file(s), ${String(remoteKeys.size)} remote object(s)`);

  if (config.dryRun) {
    console.log('Dry run — no changes made.');
    console.log(`Would upload: ${String(files.length)}`);
    console.log(`Would delete: ${stale.length === 0 ? 'nothing' : stale.join(', ')}`);
    return;
  }

  await uploadAll(s3, config, files);
  if (stale.length > 0) {
    await deleteStale(s3, config, stale);
  }

  await ingest(new BedrockAgentClient({ region: config.region }), config);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(EXIT_FAILURE);
}
