/**
 * The read path: turn a short code into a redirect decision.
 *
 * This is the hot path. Design §2 puts it at ~11,500 reads/s steady against
 * ~115 writes/s, and N2 asks for a p99 under 50 ms, so the shape of this
 * function is the shape of the system's latency budget: one primary-key
 * lookup, two columns, no second round-trip, and no work that could have been
 * done on the write path instead.
 *
 * It lives outside the route for the same reason `shorten.ts` does. Phase 4
 * wraps this in a cache-aside read and Phase 7 hangs click counting off it;
 * both are far easier to get right around a function with a four-case return
 * type than around a request handler.
 */

import { findRedirectTarget } from './db/mappings.js';
import { isRedirectableUrl } from './url.js';

/**
 * Four outcomes, and the caller has to distinguish all four:
 *
 *   found      — redirect here
 *   not-found  — no such code, and there never was one we know of
 *   expired    — the code resolved, but the link is past its TTL
 *   unsafe     — the row holds a destination we will not emit (see `url.ts`)
 */
export type RedirectResolution =
  | { outcome: 'found'; longUrl: string }
  | { outcome: 'not-found' }
  | { outcome: 'expired'; expiredAt: Date }
  | { outcome: 'unsafe'; longUrl: string };

/**
 * Resolves `shortCode` to the destination it points at, if it still points
 * anywhere.
 *
 * Expiry is evaluated here rather than as a `where expires_at > now()` clause,
 * which is worth being deliberate about because the SQL version looks strictly
 * better:
 *
 * 1. An expired link and an unknown code are different answers — 410 and 404 —
 *    and a query that filters expired rows out cannot tell them apart. It would
 *    force a second query to recover the distinction, on the path that can
 *    least afford one.
 * 2. Phase 4 caches the row, and a cached row has to be re-checked against the
 *    clock on every hit. Keeping the check in the application means the cached
 *    and uncached paths expire links by the same code, instead of the cache
 *    quietly serving links that the database would have filtered.
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
  const target = await findRedirectTarget(shortCode);

  if (target === undefined) {
    return { outcome: 'not-found' };
  }

  // NULL means the link never expires (design §6). Phase 6 is what sets a
  // non-NULL value; until then this branch is only reachable by a row written
  // by hand, and it is here first so that when Phase 6 lands, the read path
  // already honours what it writes.
  if (target.expiresAt !== null && target.expiresAt.getTime() <= now.getTime()) {
    return { outcome: 'expired', expiredAt: target.expiresAt };
  }

  if (!isRedirectableUrl(target.longUrl)) {
    return { outcome: 'unsafe', longUrl: target.longUrl };
  }

  return { outcome: 'found', longUrl: target.longUrl };
}
