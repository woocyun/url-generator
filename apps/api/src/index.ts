import Fastify from 'fastify';
import type { HealthResponse } from '@url-generator/shared';
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
 * Liveness/readiness probe.
 *
 * Phase 0 reports only on the process itself. Once the database is wired up in
 * Phase 1 this grows a dependency check and can report `degraded`.
 */
app.get('/health', async (): Promise<HealthResponse> => {
  return {
    status: 'ok',
    service: SERVICE_NAME,
    version: VERSION,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
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
// in-flight requests are not severed mid-response.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    app.log.info(`received ${signal}, shutting down`);
    void app.close().then(() => process.exit(0));
  });
}

void start();
