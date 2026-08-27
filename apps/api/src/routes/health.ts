/**
 * `GET /health` — liveness, plus the state of everything the API depends on.
 */

import type { FastifyInstance } from 'fastify';
import type { CacheHealth, HealthResponse } from '@url-generator/shared';
import { checkCache, type CacheCheck } from '../cache/client.js';
import { checkDatabase } from '../db/client.js';

const SERVICE_NAME = 'url-generator-api';
const VERSION = '0.1.0';

/** Module load is process start closely enough for an uptime counter. */
const startedAt = Date.now();

/**
 * Three states rather than two, because "no cache configured" is a deployment
 * choice and "cache is down" is a fault, and an operator reading this needs to
 * know which one they are looking at.
 */
function cacheHealth(check: CacheCheck): CacheHealth {
  if (!check.configured) return { status: 'disabled' };

  return {
    status: check.reachable ? 'ok' : 'unreachable',
    latencyMs: check.latencyMs,
    ...(check.error === undefined ? {} : { error: check.error }),
  };
}

/**
 * Always answers 200 while the process can serve a request. A dependency
 * outage shows up as `status: 'degraded'` in the body rather than as a failed
 * probe, because restarting the API would not fix Postgres and would only take
 * the cached read path down with it.
 *
 * The two probes run concurrently: they are independent, and a health endpoint
 * that a load balancer polls should not take the sum of its dependencies'
 * timeouts to answer.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (): Promise<HealthResponse> => {
    const [database, cache] = await Promise.all([checkDatabase(), checkCache()]);

    // An unreachable cache degrades the service without breaking it — every
    // read still resolves, at Postgres latency. It is reported because a
    // silently cold cache is how a system meets its latency target right up
    // until it does not, and `disabled` is excluded because a deployment that
    // was never given a Redis is not in a degraded state.
    const degraded = !database.reachable || (cache.configured && !cache.reachable);

    return {
      status: degraded ? 'degraded' : 'ok',
      service: SERVICE_NAME,
      version: VERSION,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      dependencies: {
        database: {
          status: database.reachable ? 'ok' : 'unreachable',
          latencyMs: database.latencyMs,
          ...(database.error === undefined ? {} : { error: database.error }),
        },
        cache: cacheHealth(cache),
      },
    };
  });
}
