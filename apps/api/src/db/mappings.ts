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
