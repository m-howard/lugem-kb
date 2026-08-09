import { BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { S3Client } from '@aws-sdk/client-s3';
import { Hono } from 'hono';
import { type Logger } from 'pino';

import { type AppEnv } from './app-env';
import { createAuthMiddleware } from './auth/middleware';
import { type CmsDependencies, createCmsDependencies } from './cms/dependencies';
import { type Config } from './config';
import { Answerer } from './kb/answer';
import { CitationViewer } from './kb/citation-view';
import { CorpusClient } from './kb/corpus-client';
import { Retriever } from './kb/retrieve';
import { createRateLimit } from './rate-limit';
import { createApiNotFoundRoutes } from './routes/api-not-found';
import { createAskRoutes } from './routes/ask';
import { createCmsRoutes } from './routes/cms';
import { createDocumentRoutes } from './routes/documents';
import { createHealthRoutes } from './routes/health';
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
  /** Absent when `CMS_REPOSITORY` is unset: the editorial routes are then never mounted. */
  readonly cms?: CmsDependencies | undefined;
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
    ...(config.cms === undefined
      ? {}
      : { cms: createCmsDependencies(config.cms, config.awsRegion) }),
  };
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
  app.route('/v1/documents', createDocumentRoutes({ corpus: dependencies.corpus }));
  app.route(
    '/v1/search',
    createSearchRoutes({ retriever: dependencies.retriever, viewer: dependencies.viewer }),
  );

  // Only `/v1/ask` is limited. Every other route costs a constant amount to serve; this one
  // spends money per request, and it is unauthenticated (requirements.md R22 is not met yet).
  app.use('/v1/ask', createRateLimit({ limit: dependencies.askRateLimitPerMinute }));
  app.route('/v1/ask', createAskRoutes({ answerer: dependencies.answerer }));

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
        settings: cms.settings,
        allowMergeFromCms: cms.allowMergeFromCms,
        tokens: cms.tokens,
        auth: createAuthMiddleware({ verifier: cms.verifier }),
      }),
    );
  }

  // Terminates `/v1` before the site can answer for it. Must stay after every API route.
  app.route('/v1', createApiNotFoundRoutes());

  // Catch-all. Must stay last.
  app.route('/', createSiteRoutes({ root: dependencies.siteRoot }));

  return app;
}
