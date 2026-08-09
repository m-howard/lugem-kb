import { Hono } from 'hono';

import { type AppEnv } from '../app-env';
import { type CorpusClient, DocumentNotFoundError, DocumentPolicyError } from '../kb/corpus-client';

const FORBIDDEN = 403;
const NOT_FOUND = 404;

export interface DocumentRoutesOptions {
  readonly corpus: CorpusClient;
}

/**
 * Read-only access to the markdown corpus.
 *
 * A refused path answers 403 and logs at `warn`, never 404 — the distinction matters to an
 * operator reviewing the audit log, because "someone asked for something forbidden" and
 * "someone asked for something absent" are different signals (requirements.md R9).
 *
 * @param options - The corpus client backing both routes.
 * @returns A Hono app exposing the document routes.
 */
export function createDocumentRoutes(options: DocumentRoutesOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const continuationToken = c.req.query('cursor');
    const page = await options.corpus.list(
      continuationToken === undefined ? {} : { continuationToken },
    );
    return c.json({ documents: page.documents, nextCursor: page.nextToken ?? null });
  });

  app.get('/:path{.+}', async (c) => {
    const requestedPath = c.req.param('path');
    try {
      const document = await options.corpus.get(requestedPath);
      return c.json(document);
    } catch (error) {
      if (error instanceof DocumentPolicyError) {
        c.get('logger').warn(
          { decision: 'refused', reason: error.reason, path: requestedPath },
          'document path refused by key policy',
        );
        return c.json({ error: 'forbidden', reason: error.reason }, FORBIDDEN);
      }
      if (error instanceof DocumentNotFoundError) {
        return c.json({ error: 'not_found', path: requestedPath }, NOT_FOUND);
      }
      throw error;
    }
  });

  return app;
}
