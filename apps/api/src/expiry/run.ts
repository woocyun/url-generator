/**
 * The sweeper process: run a pass, wait, run another.
 *
 * A separate process rather than a `setInterval` inside the API, and the
 * reason is the same one that put migrations in their own job (ADR 0006) —
 * background work does not belong in the process that has a latency target.
 * Three specific things follow from the separation:
 *
 * 1. The API's connection pool stays the read path's. A sweep issuing batched
 *    `DELETE`s out of the same bounded pool (`DATABASE_POOL_MAX`) takes a
 *    connection from the thing design §2 budgets 11,500 reads a second for.
 * 2. One sweeper, not one per replica. An in-process timer runs on every API
 *    container, so scaling the read path would scale the deletion rate with it
 *    for no reason.
 * 3. It can be turned off, restarted, or run by hand without touching the API.
 *    Nothing about correctness depends on it (`sweep.ts`), so being able to
 *    stop it during an incident is a feature.
 *
 * Run continuously by the `sweep` service in Compose, or once with `--once`,
 * which is what to reach for after inserting test data or when a takedown needs
 * the tombstone gone now.
 */

import { closeCache } from '../cache/client.js';
import { closeDatabase } from '../db/client.js';
import { env } from '../env.js';
import { rootCauseMessage } from '../root-cause.js';
import { sweepExpired, type SweepLogger } from './sweep.js';

/**
 * Line-per-event JSON on stdout, matching what the API's pino logger emits so
 * both services read the same way in `docker compose logs`. Not pino itself:
 * this process has no HTTP surface, and the dependency it would add is
 * Fastify's, not ours.
 */
const logger: SweepLogger & {
  info(context: object, message: string): void;
  error(context: object, message: string): void;
} = {
  debug: (context, message) => emit('debug', context, message),
  info: (context, message) => emit('info', context, message),
  warn: (context, message) => emit('warn', context, message),
  error: (context, message) => emit('error', context, message),
};

function emit(level: string, context: object, message: string): void {
  console.log(JSON.stringify({ level, time: Date.now(), msg: message, ...context }));
}

const runOnce = process.argv.includes('--once');

/** Flipped by SIGTERM so a pass in flight finishes instead of being severed. */
let stopping = false;

/**
 * Sleeps, interruptibly.
 *
 * `unref` is what lets a SIGTERM arriving mid-wait exit promptly rather than
 * holding the process open for the rest of the interval — five minutes is a
 * long time for `docker compose down` to wait on a job that is doing nothing.
 */
function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, seconds * 1_000);
    timer.unref();
  });
}

async function main(): Promise<void> {
  logger.info(
    {
      intervalSeconds: env.expirySweepIntervalSeconds,
      retentionSeconds: env.expiryRetentionSeconds,
      batchSize: env.expirySweepBatchSize,
      once: runOnce,
    },
    'expiry sweeper started',
  );

  do {
    try {
      const result = await sweepExpired(logger);

      // Info even when nothing was deleted. The useful operational signal here
      // is not "rows went away" but "the job is alive and keeping up", and a
      // log that only appears when there is work to do is indistinguishable
      // from a job that has silently stopped running.
      logger.info(
        {
          deleted: result.deleted,
          batches: result.batches,
          capped: result.capped,
          cutoff: result.cutoff.toISOString(),
          durationMs: result.durationMs,
        },
        'expiry sweep complete',
      );
    } catch (error) {
      // A failed pass is not a failed process. Postgres restarting, a lock
      // timeout, a network blip — none of it makes an expired link resolvable,
      // because the read path enforces expiry on its own. The next pass picks
      // up exactly the same rows, so there is nothing to recover and nothing
      // to retry faster than the interval.
      logger.error(
        { error: rootCauseMessage(error) },
        'expiry sweep failed; retrying next interval',
      );
    }

    if (runOnce || stopping) break;

    await sleep(env.expirySweepIntervalSeconds);
  } while (!stopping);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutting down after the current pass');
    stopping = true;
  });
}

try {
  await main();
} finally {
  await Promise.all([closeDatabase(), closeCache()]);
}
