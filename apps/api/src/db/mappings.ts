/**
 * Every statement the API issues against `url_mappings`.
 *
 * Routes and domain logic go through these functions rather than building
 * queries inline, so the set of statements that can reach the table is small
 * enough to read in one sitting — which is what makes the claims about the hot
 * path (primary-key lookups only, one round-trip per write attempt) checkable
 * rather than aspirational.
 */

import { and, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import { db } from './client.js';
import { urlMappings, type NewUrlMapping, type UrlMapping } from './schema.js';

/**
 * Claims a short code, but only if it is free.
 *
 * `INSERT ... ON CONFLICT DO NOTHING RETURNING *` is the atomic primitive the
 * whole write path rests on (design §6). The alternative — check whether the
 * code exists, then insert — leaves a window in which two writers both see a
 * free code and one of them overwrites the other's mapping. Here the loser of
 * that race gets an empty result and retries, and no mapping is ever
 * overwritten.
 *
 * Returns the inserted row, or `undefined` if the code was already taken.
 */
export async function insertMappingIfFree(
  mapping: NewUrlMapping,
): Promise<UrlMapping | undefined> {
  const [inserted] = await db
    .insert(urlMappings)
    .values(mapping)
    .onConflictDoNothing()
    .returning();

  return inserted;
}

/**
 * Re-creates an expired row in place, if it is still expired and still points
 * where the caller thinks it does.
 *
 * The only statement in this file that overwrites a mapping, and the `where`
 * clause is what makes that safe rather than a comment saying it is. Three
 * conditions have to hold at the instant Postgres evaluates them: the code is
 * the one we mean, its destination is unchanged, and it is past its expiry. A
 * live link therefore cannot be modified by this statement no matter what
 * raced ahead of it — the row simply does not match, and the caller gets
 * `undefined` and treats the code as occupied.
 *
 * The destination check is the load-bearing one. An expired row whose
 * `long_url` is *different* is a hash collision with somebody else's dead link,
 * and taking its code would point a URL that people are still holding at an
 * unrelated destination. Those rows are left for the sweep (ADR 0011).
 *
 * Every column is written, not just `expires_at`, because this is a creation
 * rather than an edit: `created_at` is when this mapping began, and the row
 * would otherwise report the lifetime of the link it replaced. `click_count`
 * resets for the same reason — Phase 7 is going to read it as this link's
 * clicks.
 */
export async function reviveExpiredMapping(
  mapping: {
    shortCode: string;
    longUrl: string;
    expiresAt: Date | null;
    isCustom?: boolean;
  },
  now: Date,
): Promise<UrlMapping | undefined> {
  const [revived] = await db
    .update(urlMappings)
    .set({
      longUrl: mapping.longUrl,
      expiresAt: mapping.expiresAt,
      createdAt: now,
      clickCount: 0,
      isCustom: mapping.isCustom ?? false,
      userId: null,
    })
    .where(
      and(
        eq(urlMappings.shortCode, mapping.shortCode),
        eq(urlMappings.longUrl, mapping.longUrl),
        isNotNull(urlMappings.expiresAt),
        lte(urlMappings.expiresAt, now),
      ),
    )
    .returning();

  return revived;
}

/**
 * Deletes up to `limit` rows that expired before `before`, and says which.
 *
 * The sweep's only statement (ADR 0011), and the three things it does beyond
 * `delete where expires_at <= $1` are each load-bearing:
 *
 * `limit` via a sub-select, because `DELETE` takes a row lock per row and holds
 * it until the statement commits. An unbounded delete against a backlog would
 * hold thousands of locks on the table the read path is using, for as long as
 * it took to finish. Batching turns one long statement into many short ones,
 * and the caller decides how many to run.
 *
 * `for update skip locked`, because more than one sweeper is a supported
 * configuration and a restarted one overlapping its predecessor is a normal
 * event. Without it the second sweeper blocks on the first's locks and then
 * deletes rows that are already gone; with it, each takes a disjoint batch and
 * neither waits.
 *
 * `returning`, because the codes are the point. A deleted row that is still in
 * the cache answers 410 for as long as an hour (`CACHE_TTL_SECONDS`) — the
 * design's note that the sweep must invalidate what it removes rather than wait
 * out the TTL. This function reports; `expiry/sweep.ts` invalidates.
 *
 * Ordered by `expires_at` so a backlog is worked oldest-first, which keeps
 * successive batches on the same end of the index and makes the pass's progress
 * monotonic rather than scattered.
 */
export async function deleteExpiredBefore(
  before: Date,
  limit: number,
): Promise<string[]> {
  const doomed = db
    .select({ shortCode: urlMappings.shortCode })
    .from(urlMappings)
    .where(and(isNotNull(urlMappings.expiresAt), lte(urlMappings.expiresAt, before)))
    .orderBy(urlMappings.expiresAt)
    .limit(limit)
    .for('update', { skipLocked: true });

  const deleted = await db
    .delete(urlMappings)
    .where(inArray(urlMappings.shortCode, doomed))
    .returning({ shortCode: urlMappings.shortCode });

  return deleted.map((row) => row.shortCode);
}

/**
 * Looks up one mapping by its code — a primary-key hit, which is the shape the
 * redirect path (Phase 3) will run millions of times a day.
 */
export async function findMappingByCode(
  shortCode: string,
): Promise<UrlMapping | undefined> {
  const [found] = await db
    .select()
    .from(urlMappings)
    .where(eq(urlMappings.shortCode, shortCode))
    .limit(1);

  return found;
}

/** The two columns a redirect decision needs, and nothing else. */
export interface RedirectTarget {
  longUrl: string;
  expiresAt: Date | null;
}

/**
 * The redirect path's only statement: a primary-key lookup for the destination
 * and its expiry.
 *
 * Narrower than `findMappingByCode` on purpose, even though both are one
 * index hit. The row carries a `text` column the hot path does not read
 * (`user_id`, `click_count`, `is_custom`), and at design §2's read rate that is
 * bytes off the wire and out of the driver 11,500 times a second for nothing.
 *
 * The shape is also the contract Phase 4 caches. A cache entry that mirrors
 * `UrlMapping` would have to be invalidated by Phase 7's click counter on every
 * single read — the write it makes is to a column in that row. Storing only
 * what a redirect decides on keeps the cached value immutable for the life of
 * the link, which is what makes a plain TTL a correct invalidation strategy
 * rather than an approximate one.
 */
export async function findRedirectTarget(
  shortCode: string,
): Promise<RedirectTarget | undefined> {
  const [found] = await db
    .select({
      longUrl: urlMappings.longUrl,
      expiresAt: urlMappings.expiresAt,
    })
    .from(urlMappings)
    .where(eq(urlMappings.shortCode, shortCode))
    .limit(1);

  return found;
}
