/**
 * The read path: turn a short code into a redirect decision.
 *
 * This is the hot path. Design §2 puts it at ~11,500 reads/s steady against
 * ~115 writes/s, and N2 asks for a p99 under 50 ms, so the shape of this
 * function is the shape of the system's latency budget: one lookup, two
 * columns, no second round-trip, and no work that could have been done on the
 * write path instead.
 *
 * As of Phase 4 that lookup is cache-aside (ADR 0009): Redis first, Postgres
 * on a miss, and the result written back. The fallback is not an error branch
 * — a cache that is unreachable, slow, or empty all arrive here as a miss, and
 * a miss is just the Phase 3 read path. That is the property N1 needs: the
 * cache can only make this slower, never wrong.
 *
 * It lives outside the route for the same reason `shorten.ts` does. Phase 7
 * hangs click counting off it, which is far easier to get right around a
 * function with a four-case return type than around a request handler.
 */

import { cacheTarget, readCachedTarget } from './cache/redirect-cache.js';
import { findRedirectTarget, type RedirectTarget } from './db/mappings.js';
import { isRedirectableUrl } from './url.js';

/** Where the answer came from. Reported so the hit rate is observable. */
export type RedirectSource = 'cache' | 'database';

/**
 * Four outcomes, and the caller has to distinguish all four:
 *
 *   found      — redirect here
 *   not-found  — no such code, and there never was one we know of
 *   expired    — the code resolved, but the link is past its TTL
 *   unsafe     — the row holds a destination we will not emit (see `url.ts`)
 */
export type RedirectResolution = (
  | { outcome: 'found'; longUrl: string }
  | { outcome: 'not-found' }
  | { outcome: 'expired'; expiredAt: Date }
  | { outcome: 'unsafe'; longUrl: string }
) & { source: RedirectSource };

/**
 * Reads the target for `shortCode`, from the cache if it is there.
 *
 * The write-back on a miss covers the negative case too — `undefined` is
 * cached as "no such code", which is what keeps a scanner's guesses from being
 * one Postgres round-trip each. See `cacheTarget` for why the two TTLs differ.
 */
async function loadTarget(
  shortCode: string,
): Promise<{ target: RedirectTarget | undefined; source: RedirectSource }> {
  const cached = await readCachedTarget(shortCode);

  if (cached.status === 'hit') {
    return { target: cached.target, source: 'cache' };
  }

  if (cached.status === 'hit-negative') {
    return { target: undefined, source: 'cache' };
  }

  const target = await findRedirectTarget(shortCode);
  await cacheTarget(shortCode, target);

  return { target, source: 'database' };
}

/**
 * Resolves `shortCode` to the destination it points at, if it still points
 * anywhere.
 *
 * Every check below runs on the cached value exactly as it runs on the row,
 * which is the point of doing them here rather than in SQL.
 *
 * Expiry is evaluated in the application rather than as a `where expires_at >
 * now()` clause, which is worth being deliberate about because the SQL version
 * looks strictly better:
 *
 * 1. An expired link and an unknown code are different answers — 410 and 404 —
 *    and a query that filters expired rows out cannot tell them apart. It would
 *    force a second query to recover the distinction, on the path that can
 *    least afford one.
 * 2. A cached row has to be re-checked against the clock on every hit no matter
 *    what the query did, since the entry outlives the moment it was read.
 *    Checking here means the cached and uncached paths expire links by the same
 *    code, instead of the cache quietly serving links the database would have
 *    filtered.
 *
 * The same argument covers `isRedirectableUrl`: a destination we refuse to
 * emit is refused whether it came from Redis or Postgres, so a planted row
 * cannot be laundered into a `Location` header by being cached first.
 *
 * The clock is the API's, not Postgres's. Both are `timestamptz`, so the
 * comparison is absolute rather than zone-dependent, and a link surviving a few
 * seconds of clock skew past its TTL is not a correctness problem — expiry is a
 * lifecycle bound, not an access control.
 */
export async function resolveShortCode(
  shortCode: string,
  now: Date = new Date(),
): Promise<RedirectResolution> {
  const { target, source } = await loadTarget(shortCode);

  if (target === undefined) {
    return { outcome: 'not-found', source };
  }

  // NULL means the link never expires (design §6). Phase 6 is what sets a
  // non-NULL value; until then this branch is only reachable by a row written
  // by hand, and it is here first so that when Phase 6 lands, the read path
  // already honours what it writes.
  if (target.expiresAt !== null && target.expiresAt.getTime() <= now.getTime()) {
    return { outcome: 'expired', expiredAt: target.expiresAt, source };
  }

  if (!isRedirectableUrl(target.longUrl)) {
    return { outcome: 'unsafe', longUrl: target.longUrl, source };
  }

  return { outcome: 'found', longUrl: target.longUrl, source };
}
