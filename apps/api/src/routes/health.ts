/**
 * `GET /health` — liveness, plus the state of everything the API depends on.
 */

import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '@url-generator/shared';
import { checkDatabase } from '../db/client.js';

const SERVICE_NAME = 'url-generator-api';
const VERSION = '0.1.0';

/** Module load is process start closely enough for an uptime counter. */
const startedAt = Date.now();

/**
 * Always answers 200 while the process can serve a request. A database outage
 * shows up as `status: 'degraded'` in the body rather than as a failed probe,
 * because restarting the API would not fix Postgres and would only take the
 * cached read path (Phase 4) down with it.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
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
}
