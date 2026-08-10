import { BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { Hono } from 'hono';
import { type Logger } from 'pino';

import { type AppEnv } from './app-env';
import { createVerifier } from './auth/create-verifier';
import { createAuthMiddleware } from './auth/middleware';
import { type IdentityVerifier } from './auth/verifier';
import { type CmsDependencies, createCmsDependencies } from './cms/dependencies';
import { type Config } from './config';
import { DynamoGapRecorder } from './feedback/recorder';
import { type GapRecorder } from './feedback/types';
import { Answerer } from './kb/answer';
import { CitationViewer } from './kb/citation-view';
import { CorpusClient } from './kb/corpus-client';
import { Retriever } from './kb/retrieve';
import { PreviewClient } from './previews/preview-client';
import { PREVIEW_MOUNT_PATH } from './previews/preview-key';
import { createRateLimit } from './rate-limit';
import { createAdminConfigRoutes } from './routes/admin-config';
import { createApiNotFoundRoutes } from './routes/api-not-found';
import { createAskRoutes } from './routes/ask';
import { createCmsRoutes } from './routes/cms';
import { createDocumentRoutes } from './routes/documents';
import { createFeedbackRoutes } from './routes/feedback';
import { createHealthRoutes } from './routes/health';
import { createIdentityRoutes } from './routes/identity';
import { createPreviewRoutes } from './routes/previews';
import { createSearchRoutes } from './routes/search';
import { createSiteRoutes } from './routes/site';

const INTERNAL_SERVER_ERROR = 500;

export interface AppDependencies {
  readonly corpus: CorpusClient;
  readonly retriever: Retriever;
  readonly viewer: CitationViewer;
  readonly answerer: Answerer;
  readonly logger: Logger;
  readonly siteRoot: string;
  /** Requests per client per minute on `/v1/ask`, the one route that bills per call. */
  readonly askRateLimitPerMinute: number;
  /** Corpus prefix, so `/v1/feedback` can refuse cited paths from outside the corpus. */
  readonly corpusPrefix: string;
  /** Absent when `CMS_REPOSITORY` is unset: the editorial routes are then never mounted. */
  readonly cms?: CmsDependencies | undefined;
  /**
   * Absent when `GAP_FEEDBACK_TABLE` is unset: no gap is recorded and `/v1/feedback` is never
   * mounted. Answering still works — it just produces no signal about what is missing.
   */
  readonly recorder?: GapRecorder | undefined;
  /**
   * Absent when `PREVIEW_BUCKET` is unset: `/previews` is never mounted, and a request for one
   * falls through to the site catch-all and its 404 rather than to a route that cannot answer.
   */
  readonly previews?: PreviewClient | undefined;
  /**
   * Present only when `READER_AUTH_REQUIRED` is true.
   *
   * Absent — the default — means `/v1/ask`, `/v1/search` and `/v1/feedback` stay open exactly as
   * they were before R22, and `/v1/identity` is never mounted. See ADR 0017.
   */
  readonly readerVerifier?: IdentityVerifier | undefined;
}

/**
 * The editorial dependencies, or nothing — all three conditions have to hold for the CMS to be
 * usable, and passing a partial set would produce a task that boots and refuses the first author.
 */
function resolveCmsDependencies(
  config: Config,
  verifier: IdentityVerifier | undefined,
): Pick<AppDependencies, 'cms'> {
  if (config.cms === undefined || verifier === undefined || config.auth === undefined) {
    return {};
  }
  return {
    cms: createCmsDependencies({
      cms: config.cms,
      region: config.awsRegion,
      verifier,
      auth: config.auth,
      previewBaseUrl: config.previews?.baseUrl,
    }),
  };
}

/**
 * The preview reader, or nothing when `PREVIEW_BUCKET` is unset.
 *
 * A second bucket, not a second prefix on the corpus one: R21 says preview builds are never
 * ingested, and a bucket Bedrock has never been pointed at cannot be. See ADR 0018.
 */
function resolvePreviewDependencies(
  config: Config,
  s3: S3Client,
): Pick<AppDependencies, 'previews'> {
  return config.previews === undefined
    ? {}
    : { previews: new PreviewClient({ s3, bucket: config.previews.bucket }) };
}

/**
 * Builds the dependency graph from configuration, constructing real AWS clients.
 *
 * Separated from {@link createApp} so tests can supply fakes without the app knowing whether its
 * collaborators talk to AWS.
 *
 * @param config - Validated configuration.
 * @param logger - Base logger.
 * @returns Dependencies ready to pass to {@link createApp}.
 */
export function createDependencies(config: Config, logger: Logger): AppDependencies {
  const s3 = new S3Client({ region: config.awsRegion });
  const verifier =
    config.auth === undefined ? undefined : createVerifier(config.auth, config.awsRegion);
  const bedrock = new BedrockAgentRuntimeClient({ region: config.awsRegion });

  const corpus = new CorpusClient({
    s3,
    bucket: config.corpusBucket,
    prefix: config.corpusPrefix,
  });
  const viewer = new CitationViewer({
    corpus,
    location: { bucket: config.corpusBucket, prefix: config.corpusPrefix },
  });
  const retriever = new Retriever({
    client: bedrock,
    knowledgeBaseId: config.knowledgeBaseId,
    scoreThreshold: config.retrievalScoreThreshold,
  });

  return {
    corpus,
    retriever,
    viewer,
    answerer: new Answerer({
      client: new BedrockRuntimeClient({ region: config.awsRegion }),
      retriever,
      viewer,
      modelId: config.answerModelId,
      maxTokens: config.answerMaxTokens,
    }),
    logger,
    siteRoot: config.siteRoot,
    askRateLimitPerMinute: config.askRateLimitPerMinute,
    corpusPrefix: config.corpusPrefix,
    ...resolveCmsDependencies(config, verifier),
    ...resolvePreviewDependencies(config, s3),
    // Built once and shared. Two verifiers in one service could disagree about who is calling.
    ...(config.readerAuthRequired && verifier !== undefined ? { readerVerifier: verifier } : {}),
    ...(config.feedback === undefined
      ? {}
      : {
          recorder: new DynamoGapRecorder({
            client: new DynamoDBClient({ region: config.awsRegion }),
            tableName: config.feedback.tableName,
            retentionDays: config.feedback.retentionDays,
            location: { bucket: config.corpusBucket, prefix: config.corpusPrefix },
          }),
        }),
  };
}

/**
 * The routes a reader uses: documents, search, ask, and the gap feedback they can send back.
 *
 * Kept together because their order relative to one another is the part that matters — and all of
 * it must still land before the `/v1` terminator and the site catch-all that `createApp` mounts.
 */
function mountReaderRoutes(app: Hono<AppEnv>, dependencies: AppDependencies): void {
  const recorded = dependencies.recorder === undefined ? {} : { recorder: dependencies.recorder };

  // Absent by default. When present it runs *before* the rate limiter on each path, so the limiter
  // can key on the reader's subject rather than a shared office address — see rate-limit.ts.
  const readerAuth =
    dependencies.readerVerifier === undefined
      ? undefined
      : createAuthMiddleware({ verifier: dependencies.readerVerifier });

  app.route('/v1/documents', createDocumentRoutes({ corpus: dependencies.corpus }));

  if (readerAuth !== undefined) {
    app.use('/v1/search', readerAuth);
  }
  app.route(
    '/v1/search',
    createSearchRoutes({
      retriever: dependencies.retriever,
      viewer: dependencies.viewer,
      ...recorded,
    }),
  );

  // Only `/v1/ask` is limited. Every other route costs a constant amount to serve; this one
  // spends money per request. The limit is a cost guard either way: with R22 off the endpoint is
  // unauthenticated, and with it on the limit is still per task rather than global.
  if (readerAuth !== undefined) {
    app.use('/v1/ask', readerAuth);
  }
  app.use('/v1/ask', createRateLimit({ limit: dependencies.askRateLimitPerMinute }));
  app.route('/v1/ask', createAskRoutes({ answerer: dependencies.answerer, ...recorded }));

  // Mounted only when GAP_FEEDBACK_TABLE is set. Rate-limited on its own window — it writes.
  if (dependencies.recorder !== undefined) {
    if (readerAuth !== undefined) {
      app.use('/v1/feedback', readerAuth);
    }
    app.use('/v1/feedback', createRateLimit({ limit: dependencies.askRateLimitPerMinute }));
    app.route(
      '/v1/feedback',
      createFeedbackRoutes({
        recorder: dependencies.recorder,
        corpusPrefix: dependencies.corpusPrefix,
      }),
    );
  }

  // The one reader path that exists to be redirected to. Mounted only alongside reader auth,
  // because without it there is no session to establish and nothing to report.
  if (readerAuth !== undefined) {
    app.use('/v1/identity', readerAuth);
    app.route('/v1/identity', createIdentityRoutes());
  }
}

/**
 * Assembles the HTTP surface.
 *
 * Route order is load-bearing: the static site is a catch-all, so it must be mounted after every
 * API path or it will answer for them. `apps/gateway/tests/integration/route-precedence.test.ts`
 * exists to keep that true.
 *
 * @param dependencies - Collaborators, real or faked.
 * @returns The configured Hono app, ready to `fetch` or serve.
 */
export function createApp(dependencies: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? crypto.randomUUID();
    c.set('startedAt', Date.now());
    c.set('requestId', requestId);
    c.set('logger', dependencies.logger.child({ requestId }));
    await next();
  });

  app.onError((error, c) => {
    c.get('logger').error({ err: error.message }, 'unhandled error');
    return c.json({ error: 'internal_error' }, INTERNAL_SERVER_ERROR);
  });

  app.route(
    '/',
    createHealthRoutes({
      corpus: dependencies.corpus,
      ...(dependencies.cms === undefined ? {} : { tokens: dependencies.cms.tokens }),
    }),
  );

  mountReaderRoutes(app, dependencies);

  // Mounted only when CMS_REPOSITORY is set. An unconfigured deployment has no editorial surface
  // at all, rather than one that answers 500 — see resolveCmsConfig in config.ts.
  if (dependencies.cms !== undefined) {
    const cms = dependencies.cms;
    app.route(
      '/v1/cms',
      createCmsRoutes({
        reader: cms.reader,
        drafts: cms.drafts,
        submissions: cms.submissions,
        media: cms.media,
        settings: cms.settings,
        allowMergeFromCms: cms.allowMergeFromCms,
        tokens: cms.tokens,
        client: cms.client,
        previewBaseUrl: cms.previewBaseUrl,
        auth: createAuthMiddleware({ verifier: cms.verifier }),
      }),
    );

    // Unauthenticated on purpose, and only these fields — see the route's own note. Mounted
    // alongside rather than inside `/v1/cms`, so that sub-app's "everything here needs a token"
    // rule survives someone adding a route next to this one.
    app.route('/v1/admin', createAdminConfigRoutes({ auth: cms.auth }));
  }

  // Mounted only when PREVIEW_BUCKET is set, and before the catch-all — the site would otherwise
  // answer for `/previews/...` with its own 404 page and a 200-shaped path never reaching S3.
  if (dependencies.previews !== undefined) {
    app.route(PREVIEW_MOUNT_PATH, createPreviewRoutes({ client: dependencies.previews }));
  }

  // Terminates `/v1` before the site can answer for it. Must stay after every API route.
  app.route('/v1', createApiNotFoundRoutes());

  // Catch-all. Must stay last.
  app.route('/', createSiteRoutes({ root: dependencies.siteRoot }));

  return app;
}
