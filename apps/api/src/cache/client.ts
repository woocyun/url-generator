/**
 * Redis connection for the API process.
 *
 * The difference between this file and `db/client.ts` is the whole point of
 * the phase, and every option below follows from it: Postgres is the source of
 * truth and the API has no useful behaviour without it, while Redis is an
 * optimization the read path is expected to survive losing. N1 asks for 99.99%
 * on the redirect path (design §1); a cache that can take that path down with
 * it would be a net loss no matter how many round-trips it saved.
 *
 * So the connection is configured to *fail fast and stay out of the way*:
 * commands are bounded by a timeout, they are never queued while the socket is
 * down, and every caller in `redirect-cache.ts` treats an error as a miss.
 * Redis being unreachable makes the service slower, never wrong.
 *
 * The client is ioredis rather than node-redis for one reason that matters
 * here: `enableOfflineQueue: false` plus `commandTimeout` give exactly the
 * fail-fast semantics above as constructor options, instead of as a wrapper
 * this code would have to write and get right around every call.
 */

import { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import { env } from '../env.js';
import { rootCauseMessage } from '../root-cause.js';

/**
 * How long a single command may take before it is abandoned.
 *
 * N2 gives the whole redirect 50 ms at p99. A cache lookup that spends any
 * meaningful fraction of that has already lost to the ~0.5 ms primary-key
 * lookup it exists to avoid, so there is no point waiting on it: 100 ms is far
 * past "the cache is helping" and comfortably inside the budget it would
 * otherwise blow. A timed-out command is a miss, and the request continues to
 * Postgres.
 */
const COMMAND_TIMEOUT_MS = 100;

/**
 * The cache, or `undefined` when `REDIS_URL` is not set.
 *
 * Unset is a supported configuration rather than an error — the read path is
 * correct without it (see `redirect-cache.ts`), and `npm run dev` outside
 * Compose should not require a Redis. `DATABASE_URL` is required for the
 * opposite reason: there is no correct behaviour without it.
 */
const client: Redis | undefined =
  env.redisUrl === undefined
    ? undefined
    : new Redis(env.redisUrl, {
        commandTimeout: COMMAND_TIMEOUT_MS,

        // The default queues commands issued while the socket is down and
        // replays them on reconnect. On a cache read that is the wrong trade
        // twice over: the request waits on a reconnect it does not need, and
        // it waits to be told something Postgres could have answered already.
        // Off, a command issued while disconnected rejects immediately, which
        // is precisely the signal `redirect-cache.ts` wants.
        enableOfflineQueue: false,

        // Same reasoning for a command already in flight when the connection
        // drops: retrying it costs the request another round-trip to learn
        // what a fallback to Postgres would have told it.
        maxRetriesPerRequest: 1,

        // Named so `CLIENT LIST` on a wedged Redis says which process is
        // holding a connection.
        connectionName: 'url-generator-api',
      });

/**
 * The last connection-level failure, for `/health` to report.
 *
 * ioredis raises connection faults as `error` events rather than as rejected
 * commands, and an unhandled `error` event on an EventEmitter takes the
 * process down — so this handler is not optional bookkeeping, it is what keeps
 * an unreachable cache from killing an API that could still serve every
 * request from Postgres.
 */
let lastError: string | undefined;

let logger: FastifyBaseLogger | undefined;

client?.on('error', (error: unknown) => {
  const message = rootCauseMessage(error);

  // Reconnection backs off to one attempt every ~5s and each failure emits
  // again, so an outage of any length is the same message on repeat. Logging
  // only on change keeps a Redis that is down for an hour from being the only
  // thing in the log.
  if (message !== lastError) {
    logger?.warn({ err: error }, 'cache connection error');
  }

  lastError = message;
});

client?.on('ready', () => {
  if (lastError !== undefined) {
    logger?.info('cache connection restored');
    lastError = undefined;
  }
});

/**
 * Hands the cache the server's logger.
 *
 * The connection is opened at module load, before Fastify exists, so its early
 * events have nowhere to go but `lastError`. Everything after this call is
 * logged in the same stream as the rest of the service.
 */
export function attachCacheLogger(log: FastifyBaseLogger): void {
  logger = log;
}

/** The connection, or `undefined` when the cache is not configured. */
export function cacheClient(): Redis | undefined {
  return client;
}

export interface CacheCheck {
  /** False when `REDIS_URL` is unset — a configuration, not a fault. */
  configured: boolean;
  reachable: boolean;
  latencyMs: number;
  error?: string;
}

/**
 * Round-trips a `PING`.
 *
 * No explicit timeout race here, unlike `checkDatabase`: `commandTimeout`
 * bounds every command on this connection, and a command issued while the
 * socket is down rejects rather than waiting. Both of the ways this could hang
 * are already closed by the constructor.
 */
export async function checkCache(): Promise<CacheCheck> {
  if (client === undefined) {
    return { configured: false, reachable: false, latencyMs: 0 };
  }

  const startedAt = performance.now();

  try {
    await client.ping();

    return {
      configured: true,
      reachable: true,
      latencyMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return {
      configured: true,
      reachable: false,
      latencyMs: Math.round(performance.now() - startedAt),
      error: rootCauseMessage(error),
    };
  }
}

/**
 * Closes the connection on shutdown.
 *
 * `quit` waits for in-flight commands and says goodbye; if the server is
 * already gone that never completes, so the disconnect is unconditional
 * afterwards. Nothing in the cache needs to be flushed — it holds no state
 * that is not recoverable from Postgres.
 */
export async function closeCache(): Promise<void> {
  if (client === undefined) return;

  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
