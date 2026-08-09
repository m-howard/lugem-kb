import { BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';
import { S3Client } from '@aws-sdk/client-s3';
import { Hono } from 'hono';
import { type Logger } from 'pino';

import { type AppEnv } from './app-env';
import { type Config } from './config';
import { CorpusClient } from './kb/corpus-client';
import { Retriever } from './kb/retrieve';
import { createDocumentRoutes } from './routes/documents';
import { createHealthRoutes } from './routes/health';
import { createSearchRoutes } from './routes/search';
import { createSiteRoutes } from './routes/site';

const INTERNAL_SERVER_ERROR = 500;

export interface AppDependencies {
  readonly corpus: CorpusClient;
  readonly retriever: Retriever;
  readonly logger: Logger;
  readonly siteRoot: string;
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

  return {
    corpus: new CorpusClient({ s3, bucket: config.corpusBucket, prefix: config.corpusPrefix }),
    retriever: new Retriever({
      client: bedrock,
      knowledgeBaseId: config.knowledgeBaseId,
      scoreThreshold: config.retrievalScoreThreshold,
    }),
    logger,
    siteRoot: config.siteRoot,
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
    c.set('requestId', requestId);
    c.set('logger', dependencies.logger.child({ requestId }));
    await next();
  });

  app.onError((error, c) => {
    c.get('logger').error({ err: error.message }, 'unhandled error');
    return c.json({ error: 'internal_error' }, INTERNAL_SERVER_ERROR);
  });

  app.route('/', createHealthRoutes({ corpus: dependencies.corpus }));
  app.route('/v1/documents', createDocumentRoutes({ corpus: dependencies.corpus }));
  app.route('/v1/search', createSearchRoutes({ retriever: dependencies.retriever }));

  // Catch-all. Must stay last.
  app.route('/', createSiteRoutes({ root: dependencies.siteRoot }));

  return app;
}
