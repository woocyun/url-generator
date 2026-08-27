/**
 * Database connection for the API process.
 *
 * The driver is postgres.js rather than node-postgres: it is a single
 * dependency with no native build step, and its prepared-statement handling
 * matters on a read path that will run the same primary-key lookup millions of
 * times (design §2). Drizzle supports both; nothing above this file knows
 * which one is underneath.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env.js';
import { rootCauseMessage } from '../root-cause.js';
import * as schema from './schema.js';

const connection = postgres(env.databaseUrl, {
  max: env.databasePoolMax,
  // A connection that cannot be established in 10s is a failure worth
  // reporting, not something to hang a request on indefinitely.
  connect_timeout: 10,
});

export const db = drizzle(connection, { schema });

export type Database = typeof db;

/** How long `checkDatabase` waits before calling the database unreachable. */
const HEALTH_CHECK_TIMEOUT_MS = 2_000;

export interface DatabaseCheck {
  reachable: boolean;
  latencyMs: number;
  error?: string;
}

/**
 * Round-trips the cheapest possible query to prove the connection works.
 *
 * Bounded explicitly: the health endpoint is what a load balancer polls, so it
 * has to answer quickly even when Postgres is the thing that is wedged. Note
 * that the timeout only bounds the *answer* — the query itself keeps running
 * until the driver gives up on it.
 */
export async function checkDatabase(): Promise<DatabaseCheck> {
  const startedAt = performance.now();

  try {
    await Promise.race([
      connection`select 1`,
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`timed out after ${HEALTH_CHECK_TIMEOUT_MS}ms`)),
          HEALTH_CHECK_TIMEOUT_MS,
        ).unref();
      }),
    ]);

    return {
      reachable: true,
      latencyMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return {
      reachable: false,
      latencyMs: Math.round(performance.now() - startedAt),
      error: rootCauseMessage(error),
    };
  }
}

/**
 * Drains the pool on shutdown. Compose sends SIGTERM on `down`; without this
 * Postgres is left to time out connections that nobody is on the other end of.
 */
export async function closeDatabase(): Promise<void> {
  await connection.end({ timeout: 5 });
}
