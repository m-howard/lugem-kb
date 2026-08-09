import { createApp, createDependencies } from './app';
import { ConfigError, loadConfig } from './config';
import { createLogger } from './logging';

const EXIT_CONFIG_ERROR = 78; // EX_CONFIG, sysexits.h — distinguishable from a crash in ECS events.

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      // Deliberately console, not pino: the logger's level comes from the config that just
      // failed to load, so routing this through pino risks swallowing the only useful message.
      // eslint-disable-next-line no-console -- see above; this is the last-resort error channel
      console.error(error.message);
      process.exit(EXIT_CONFIG_ERROR);
    }
    throw error;
  }

  const logger = createLogger({ level: config.logLevel, serviceName: 'lugem-gateway' });
  const app = createApp(createDependencies(config, logger));

  logger.info({ port: config.port, siteRoot: config.siteRoot }, 'gateway listening');

  Bun.serve({ port: config.port, fetch: app.fetch });
}

main();
