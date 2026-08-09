import { type Hono } from 'hono';
import { pino } from 'pino';

import {
  type FakeAnswerOptions,
  fakeBedrockClient,
  fakeBedrockRuntimeClient,
  type FakeRetrievalResult,
  fakeS3Client,
} from './fake-aws';
import { createApp } from '../../src/app';
import { type AppEnv } from '../../src/app-env';
import { Answerer } from '../../src/kb/answer';
import { CitationViewer } from '../../src/kb/citation-view';
import { CorpusClient } from '../../src/kb/corpus-client';
import { Retriever } from '../../src/kb/retrieve';

export const TEST_BUCKET = 'test-corpus';
export const TEST_PREFIX = 'docs/';
export const TEST_SITE_ROOT = 'apps/gateway/tests/fixtures/site';

const TEST_SCORE_THRESHOLD = 0.4;
const TEST_ANSWER_MAX_TOKENS = 700;
const TEST_ASK_RATE_LIMIT = 100;

export interface TestAppOptions {
  readonly objects?: Readonly<Record<string, string>>;
  readonly retrievalResults?: readonly FakeRetrievalResult[];
  readonly corpusUnreachable?: boolean;
  readonly siteRoot?: string;
  /** Answer streaming behaviour. Defaults to a single chunk. */
  readonly answer?: FakeAnswerOptions;
  /** Requests per client per minute on `/v1/ask`. High by default so tests do not trip it. */
  readonly askRateLimitPerMinute?: number;
}

/**
 * Assembles the real app over fake AWS clients.
 *
 * The app is built by the same `createApp` production uses, so route ordering — the thing these
 * tests exist to protect — is exercised exactly as deployed.
 *
 * @param options - Corpus contents, retrieval results, answer behaviour, and failure toggles.
 * @returns The app, ready for `app.request(...)`.
 */
export function buildTestApp(options: TestAppOptions = {}): Hono<AppEnv> {
  const s3 = fakeS3Client({
    objects: options.objects ?? {},
    ...(options.corpusUnreachable === undefined ? {} : { unreachable: options.corpusUnreachable }),
  });

  const corpus = new CorpusClient({ s3, bucket: TEST_BUCKET, prefix: TEST_PREFIX });
  const viewer = new CitationViewer({
    corpus,
    location: { bucket: TEST_BUCKET, prefix: TEST_PREFIX },
  });
  const retriever = new Retriever({
    client: fakeBedrockClient(options.retrievalResults ?? []),
    knowledgeBaseId: 'KB-TEST',
    scoreThreshold: TEST_SCORE_THRESHOLD,
  });

  return createApp({
    corpus,
    retriever,
    viewer,
    answerer: new Answerer({
      client: fakeBedrockRuntimeClient(options.answer ?? { chunks: ['A grounded answer.'] }),
      retriever,
      viewer,
      modelId: 'test.answer-model-v1:0',
      maxTokens: TEST_ANSWER_MAX_TOKENS,
    }),
    // Silent: these tests assert on HTTP responses, and pino's output would drown the reporter.
    logger: pino({ level: 'silent' }),
    siteRoot: options.siteRoot ?? TEST_SITE_ROOT,
    askRateLimitPerMinute: options.askRateLimitPerMinute ?? TEST_ASK_RATE_LIMIT,
  });
}
