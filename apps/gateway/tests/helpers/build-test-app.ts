import { type Hono } from 'hono';
import { pino } from 'pino';

import { fakeBedrockClient, type FakeRetrievalResult, fakeS3Client } from './fake-aws';
import { createApp } from '../../src/app';
import { type AppEnv } from '../../src/app-env';
import { CorpusClient } from '../../src/kb/corpus-client';
import { Retriever } from '../../src/kb/retrieve';

export const TEST_PREFIX = 'docs/';
export const TEST_SITE_ROOT = 'apps/gateway/tests/fixtures/site';

const TEST_SCORE_THRESHOLD = 0.4;

export interface TestAppOptions {
  readonly objects?: Readonly<Record<string, string>>;
  readonly retrievalResults?: readonly FakeRetrievalResult[];
  readonly corpusUnreachable?: boolean;
  readonly siteRoot?: string;
}

/**
 * Assembles the real app over fake AWS clients.
 *
 * The app is built by the same `createApp` production uses, so route ordering — the thing these
 * tests exist to protect — is exercised exactly as deployed.
 *
 * @param options - Corpus contents, retrieval results, and failure toggles.
 * @returns The app, ready for `app.request(...)`.
 */
export function buildTestApp(options: TestAppOptions = {}): Hono<AppEnv> {
  const s3 = fakeS3Client({
    objects: options.objects ?? {},
    ...(options.corpusUnreachable === undefined ? {} : { unreachable: options.corpusUnreachable }),
  });

  return createApp({
    corpus: new CorpusClient({ s3, bucket: 'test-corpus', prefix: TEST_PREFIX }),
    retriever: new Retriever({
      client: fakeBedrockClient(options.retrievalResults ?? []),
      knowledgeBaseId: 'KB-TEST',
      scoreThreshold: TEST_SCORE_THRESHOLD,
    }),
    // Silent: these tests assert on HTTP responses, and pino's output would drown the reporter.
    logger: pino({ level: 'silent' }),
    siteRoot: options.siteRoot ?? TEST_SITE_ROOT,
  });
}
