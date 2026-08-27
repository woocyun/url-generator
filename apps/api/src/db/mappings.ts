/**
 * Every statement the API issues against `url_mappings`.
 *
 * Routes and domain logic go through these functions rather than building
 * queries inline, so the set of statements that can reach the table is small
 * enough to read in one sitting — which is what makes the claims about the hot
 * path (primary-key lookups only, one round-trip per write attempt) checkable
 * rather than aspirational.
 */

import { eq } from 'drizzle-orm';
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
