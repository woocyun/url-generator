/**
 * The cleanup sweep (design §7 Phase 6, ADR 0011): delete rows whose links
 * expired long enough ago that nobody needs to be told about them any more.
 *
 * Worth being clear about what this is *not*. It is not what makes expiry work
 * — `redirect.ts` has refused expired links since Phase 3, and it does so on
 * the row and on the cached copy alike. If this job never ran, every expired
 * link would still be dead; the table would simply keep growing. That is what
 * makes the sweep safe to batch, safe to run late, and safe to have fail: it
 * reclaims storage and it reclaims aliases, and neither is urgent.
 *
 * What it *is* responsible for is the transition from 410 to 404. An expired
 * row is a tombstone — it is how `GET /{code}` can say "this link existed and
 * ran out" rather than "no such link" — and deleting it is the decision to stop
 * saying so. The retention window is that decision expressed as a duration.
 *
 * The one thing this job must not do lazily is leave the cache holding a row it
 * deleted. A cached entry outlives its row by up to `CACHE_TTL_SECONDS`, so a
 * swept code would keep answering 410 for an hour after the fact it described
 * stopped being true. Every batch invalidates what it removed.
 */

import { invalidateCachedTarget } from '../cache/redirect-cache.js';
import { deleteExpiredBefore } from '../db/mappings.js';
import { env } from '../env.js';

/**
 * What the sweep needs to say and to whom, structurally rather than by
 * importing one.
 *
 * This job runs as its own process (`run.ts`), so pulling in Fastify's logger
 * type to describe two method calls would make a server framework a dependency
 * of a `DELETE` loop. A pino logger satisfies this shape, which is what keeps
 * the option of running the sweep inside the API open.
 */
export interface SweepLogger {
  debug(context: object, message: string): void;
  warn(context: object, message: string): void;
}

export interface SweepResult {
  /** Rows deleted across every batch in this pass. */
  deleted: number;
  /** Batches run. Hitting the cap means there is more to do next pass. */
  batches: number;
  /** True when the pass stopped at `EXPIRY_SWEEP_MAX_BATCHES`, not at an empty batch. */
  capped: boolean;
  /** The instant rows had to have expired before to be eligible. */
  cutoff: Date;
  durationMs: number;
}

/**
 * The cutoff for a pass starting at `now`: expiry plus the retention window.
 *
 * Exported because it is the whole policy in one line, and both the sweep and
 * anything asking "how big is the backlog" have to agree on it.
 */
export function sweepCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - env.expiryRetentionSeconds * 1_000);
}

/**
 * Runs one pass: batches of deletions until nothing is left to delete, the cap
 * is reached, or a batch fails.
 *
 * The cutoff is computed once at the top rather than per batch. A pass working
 * through a backlog can run for a while, and a cutoff that crept forward
 * underneath it would make "what this pass was responsible for" unanswerable —
 * it would sweep rows that expired *during* the pass, which is next pass's
 * work. Fixing it also makes the pass idempotent to reason about: the same
 * `now` deletes the same set.
 *
 * A short batch ends the pass, because the sub-select asks for `limit` rows and
 * got fewer — there are no more. Note `skip locked` makes that inference
 * slightly conservative under a second concurrent sweeper: rows it has locked
 * are invisible here and can shorten a batch. Ending early is the right
 * response to that anyway, since the other sweeper is deleting them.
 */
export async function sweepExpired(
  logger: SweepLogger,
  now: Date = new Date(),
): Promise<SweepResult> {
  const startedAt = performance.now();
  const cutoff = sweepCutoff(now);

  let deleted = 0;
  let batches = 0;

  while (batches < env.expirySweepMaxBatches) {
    const codes = await deleteExpiredBefore(cutoff, env.expirySweepBatchSize);
    batches += 1;
    deleted += codes.length;

    // Sequentially, not `Promise.all`. This is background work with no latency
    // target, and a batch of 500 concurrent commands is a burst on the
    // connection the read path is sharing — the one thing this job is not
    // allowed to slow down. Every call swallows its own failures
    // (`redirect-cache.ts`), so an unreachable Redis costs the loop nothing and
    // the entries expire on their own TTL.
    for (const code of codes) {
      await invalidateCachedTarget(code);
    }

    if (codes.length < env.expirySweepBatchSize) {
      return {
        deleted,
        batches,
        capped: false,
        cutoff,
        durationMs: Math.round(performance.now() - startedAt),
      };
    }

    logger.debug({ deleted, batches }, 'sweep batch complete');
  }

  // Every batch came back full. There is more expired than one pass removes,
  // which is normal after a backlog and worth saying out loud: if it persists,
  // the batch size or the interval is wrong for this table's write rate.
  logger.warn(
    { deleted, batches, cutoff: cutoff.toISOString() },
    'expiry sweep hit its batch cap; more rows remain',
  );

  return {
    deleted,
    batches,
    capped: true,
    cutoff,
    durationMs: Math.round(performance.now() - startedAt),
  };
}
