import { ConfigError } from '../config';
import { logger } from '../utils/logger';
import { APP_VERSION } from '../version';
import { createWebApp } from './app';
import { loadWebConfig } from './config';

/** Hard limit for shutdown; the container's stop grace period should be longer. */
const SHUTDOWN_TIMEOUT_MS = 45_000;

function describeStartupError(error: unknown): string {
  if (error instanceof ConfigError) return error.message;
  if (error instanceof Error && /must contain between 12 and 1024/.test(error.message)) {
    return `ADMIN_INITIAL_PASSWORD: ${error.message}`;
  }
  if (error instanceof Error && /ADMIN_INITIAL_PASSWORD/.test(error.message)) return error.message;
  const code =
    error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : error instanceof Error
        ? error.name
        : 'UNKNOWN';
  if (code === 'EADDRINUSE')
    return 'The web port is already in use. Change WEB_PORT or stop the other service.';
  if (code === 'EACCES')
    return 'Permission denied while starting. Check file permissions for the data and secrets directories.';
  return `The service could not start (${code}). Check the configuration described in .env.example.`;
}

async function main(): Promise<void> {
  const config = loadWebConfig();
  logger.setLevel(config.logLevel);
  const app = await createWebApp({
    config,
    assetRoot: process.env.WEB_ASSET_ROOT,
    startScheduler: true,
  });

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info('Shutting down', { signal });
    const force = setTimeout(() => {
      logger.error('Shutdown timed out; exiting');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    try {
      await app.close();
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.once('SIGINT', () => void stop('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
  logger.info(`${config.displayName} web server listening`, {
    host: config.host,
    port: config.port,
    version: APP_VERSION,
  });
}

// Last-resort handlers: log a sanitized description, then exit so the container restarts cleanly.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    error: reason instanceof Error ? reason.name : 'UNKNOWN',
  });
  process.exit(1);
});
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error: error.name });
  process.exit(1);
});

main().catch((error: unknown) => {
  process.stderr.write(`${describeStartupError(error)}\n`);
  process.exit(1);
});
