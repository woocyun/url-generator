import Fastify from 'fastify';
import type { HealthResponse } from '@url-generator/shared';
import { checkDatabase, closeDatabase } from './db/client.js';
import { env } from './env.js';

const SERVICE_NAME = 'url-generator-api';
const VERSION = '0.1.0';

const startedAt = Date.now();

const app = Fastify({
  logger: {
    level: env.nodeEnv === 'production' ? 'info' : 'debug',
  },
});

/**
 * Liveness probe, plus the state of everything the API depends on.
 *
 * Always answers 200 while the process can serve a request. A database outage
 * shows up as `status: 'degraded'` in the body rather than as a failed probe,
 * because restarting the API would not fix Postgres and would only take the
 * cached read path (Phase 4) down with it.
 */
app.get('/health', async (): Promise<HealthResponse> => {
  const database = await checkDatabase();

  return {
    status: database.reachable ? 'ok' : 'degraded',
    service: SERVICE_NAME,
    version: VERSION,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    dependencies: {
      database: {
        status: database.reachable ? 'ok' : 'unreachable',
        latencyMs: database.latencyMs,
        ...(database.error === undefined ? {} : { error: database.error }),
      },
    },
  };
});

async function start(): Promise<void> {
  try {
    await app.listen({ port: env.port, host: env.host });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

// Compose sends SIGTERM on `docker compose down`; close connections cleanly so
// in-flight requests are not severed mid-response and Postgres is not left
// holding sessions nobody is on the other end of.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    app.log.info(`received ${signal}, shutting down`);
    void app
      .close()
      .then(() => closeDatabase())
      .then(() => process.exit(0));
  });
}

void start();
