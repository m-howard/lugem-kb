#!/usr/bin/env bun
/**
 * Boots the real gateway against the real Docusaurus build for Playwright, with the AWS-backed
 * collaborators stubbed.
 *
 * The point of e2e here is the seam an app-factory test cannot reach: `createApp` composed with
 * a genuine built site, served over a real socket. Route precedence is the thing worth checking
 * that way — a catch-all static handler mounted too early answers `/v1/*` with HTML and a 200,
 * which no health check notices.
 *
 * AWS is stubbed rather than reached: e2e should fail because the wiring broke, not because a
 * credential expired.
 */
import { type BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';
import { type BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { type S3Client } from '@aws-sdk/client-s3';

import { createApp } from '../../apps/gateway/src/app';
import { Answerer } from '../../apps/gateway/src/kb/answer';
import { CitationViewer } from '../../apps/gateway/src/kb/citation-view';
import { CorpusClient } from '../../apps/gateway/src/kb/corpus-client';
import { Retriever } from '../../apps/gateway/src/kb/retrieve';
// Reused rather than constructing pino here: runtime dependencies resolve from the workspace
// that declares them, and this script lives outside every workspace.
import { createLogger } from '../../apps/gateway/src/logging';

const DEFAULT_PORT = 4173;
const SCORE_THRESHOLD = 0.4;
const PREFIX = 'docs/';
const BUCKET = 'e2e-corpus';
const ANSWER_MAX_TOKENS = 700;
const ASK_RATE_LIMIT_PER_MINUTE = 100;

/**
 * A question the stub deliberately cannot answer, so the UI's no-coverage state is reachable
 * without real retrieval. The spec asks about unicorns; nothing in the corpus mentions them.
 */
const UNCOVERED_MARKER = 'unicorn';

const ANSWER_CHUNKS = [
  'The stack consumes an existing VPC and never creates one. [1] ',
  'Subnet membership is verified during preview.',
];

const CORPUS: Record<string, string> = {
  'docs/index.md': '# Lugem Knowledge Base\n',
  'docs/adr/0001-bun-workspace-monorepo.md':
    '---\ntitle: 0001 — Bun workspace monorepo\nlast_reviewed: 2026-08-09\n---\n\n# ADR 0001\n',
};

const stubS3 = {
  send: (command: unknown): Promise<unknown> => {
    const name = command?.constructor.name ?? '';
    if (name === 'HeadBucketCommand') {
      return Promise.resolve({});
    }
    if (name === 'ListObjectsV2Command') {
      return Promise.resolve({
        Contents: Object.entries(CORPUS).map(([Key, body]) => ({
          Key,
          Size: body.length,
          LastModified: new Date('2026-08-01T00:00:00.000Z'),
        })),
      });
    }
    if (name === 'GetObjectCommand') {
      const key = (command as { input: { Key?: string } }).input.Key ?? '';
      const body = CORPUS[key];
      if (body === undefined) {
        return Promise.reject(Object.assign(new Error('missing'), { name: 'NoSuchKey' }));
      }
      return Promise.resolve({ Body: { transformToString: () => Promise.resolve(body) } });
    }
    return Promise.reject(new Error(`Unexpected S3 command: ${name}`));
  },
} as unknown as S3Client;

const stubBedrock = {
  send: (command: unknown): Promise<unknown> => {
    const question =
      (command as { input?: { retrievalQuery?: { text?: string } } }).input?.retrievalQuery?.text ??
      '';
    if (question.toLowerCase().includes(UNCOVERED_MARKER)) {
      return Promise.resolve({ retrievalResults: [] });
    }
    return Promise.resolve({
      retrievalResults: [
        {
          content: { text: 'Bun workspaces keep the monorepo to one lockfile.' },
          location: {
            s3Location: { uri: `s3://${BUCKET}/docs/adr/0001-bun-workspace-monorepo.md` },
          },
          score: 0.88,
        },
      ],
    });
  },
} as unknown as BedrockAgentRuntimeClient;

const stubBedrockRuntime = {
  // eslint-disable-next-line @typescript-eslint/require-await
  send: async (): Promise<unknown> => ({
    // eslint-disable-next-line @typescript-eslint/require-await
    stream: (async function* stream() {
      for (const text of ANSWER_CHUNKS) {
        yield { contentBlockDelta: { delta: { text } } };
      }
      yield { metadata: { usage: { inputTokens: 1200, outputTokens: 42 } } };
    })(),
  }),
} as unknown as BedrockRuntimeClient;

const port = Number(process.env['PORT'] ?? DEFAULT_PORT);

const corpus = new CorpusClient({ s3: stubS3, bucket: BUCKET, prefix: PREFIX });
const viewer = new CitationViewer({ corpus, location: { bucket: BUCKET, prefix: PREFIX } });
const retriever = new Retriever({
  client: stubBedrock,
  knowledgeBaseId: 'KB-E2E',
  scoreThreshold: SCORE_THRESHOLD,
});

const app = createApp({
  corpus,
  retriever,
  viewer,
  answerer: new Answerer({
    client: stubBedrockRuntime,
    retriever,
    viewer,
    modelId: 'e2e.stub-answer-model',
    maxTokens: ANSWER_MAX_TOKENS,
  }),
  logger: createLogger({ level: 'silent' }),
  siteRoot: 'apps/docs/build',
  askRateLimitPerMinute: ASK_RATE_LIMIT_PER_MINUTE,
});

Bun.serve({ port, fetch: app.fetch });
console.log(`e2e gateway listening on http://127.0.0.1:${String(port)}`);
