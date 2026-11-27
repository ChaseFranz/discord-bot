import dotenv from 'dotenv';
import { startApp } from './app.js';
import { ConfigError, loadConfig } from './config/config.js';
import { createLogger, describeError } from './logging/logger.js';

dotenv.config({ quiet: true });

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n\nSee .env.example for every setting.\n`);
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger(config.logLevel);
  process.on('unhandledRejection', (reason) => logger.error(`Unhandled promise rejection: ${describeError(reason)}`));
  process.on('uncaughtException', (error) => {
    logger.error(`Uncaught exception: ${describeError(error)}`);
    process.exit(1);
  });

  const app = await startApp(config, logger);

  const shutdown = (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    app
      .stop()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error(`Shutdown failed: ${describeError(error)}`);
        process.exit(1);
      });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  process.stderr.write(`Failed to start: ${describeError(error)}\n`);
  process.exit(1);
});
