import { type DestinationStream, type Logger, pino } from 'pino';

/**
 * Header and field paths scrubbed before anything reaches CloudWatch (requirements.md R9).
 *
 * The identity headers matter as much as the bearer token: an ALB running OIDC authentication
 * forwards a signed JWT in `x-amzn-oidc-data`, which is a credential in every sense that counts.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-amzn-oidc-accesstoken"]',
  'req.headers["x-amzn-oidc-data"]',
  'req.headers["x-amzn-oidc-identity"]',
  'headers.authorization',
  'headers.cookie',
  'headers["x-amzn-oidc-accesstoken"]',
  'headers["x-amzn-oidc-data"]',
  'headers["x-amzn-oidc-identity"]',
  'authorization',
] as const;

export const REDACTED_PLACEHOLDER = '[redacted]';

export interface LoggerOptions {
  readonly level: string;
  readonly serviceName?: string;
  /** Test seam: pino writes here instead of stdout. */
  readonly destination?: DestinationStream;
}

/**
 * Builds the application logger.
 *
 * Policy refusals are logged at `warn` rather than embedded in an `info` message, so alarms can
 * key on level instead of pattern-matching message text that will drift (requirements.md R9).
 *
 * @param options - Level, optional service name, and an optional destination stream for tests.
 * @returns A configured pino logger.
 */
export function createLogger(options: LoggerOptions): Logger {
  const base = options.serviceName === undefined ? {} : { service: options.serviceName };

  return pino(
    {
      level: options.level,
      base,
      redact: { paths: [...REDACTED_PATHS], censor: REDACTED_PLACEHOLDER },
      formatters: {
        level: (label) => ({ level: label }),
      },
    },
    options.destination,
  );
}
