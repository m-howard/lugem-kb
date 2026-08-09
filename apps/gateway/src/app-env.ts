import { type Logger } from 'pino';

/**
 * Hono context bindings shared by every route.
 *
 * The request logger is put on the context by middleware rather than imported as a module
 * singleton, so each request's logger can carry that request's id without global state.
 */
export interface AppEnv {
  Variables: {
    logger: Logger;
    requestId: string;
  };
}
