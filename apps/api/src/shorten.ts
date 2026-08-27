/**
 * The write path: turn a canonical URL into a stored mapping.
 *
 * This is the collision-retry loop ADR 0003 promised, and it is the most
 * interesting part of the design. Codes are derived from the URL, so two
 * different URLs can hash to the same code; the table's primary key is what
 * detects that, and re-hashing with a bumped attempt number is what resolves
 * it.
 *
 * Three outcomes, and the caller has to distinguish all three:
 *
 *   created   — this call inserted the row
 *   existing  — the URL was already shortened; the same code comes back
 *   exhausted — every attempt collided, which is a 500 and an alert, never a
 *               silently duplicated or overwritten mapping
 *
 * Phase 5 adds the second way in — `claimAlias`, where the caller brings the
 * code instead of deriving it. It shares this file rather than getting its own
 * because both are the same operation with the same guarantee: one atomic
 * claim against the primary key, and no mapping is ever overwritten. What they
 * do not share is the retry, and that difference is the whole of the feature —
 * see `claimAlias`.
 */

import { invalidateCachedTarget } from './cache/redirect-cache.js';
import { findMappingByCode, insertMappingIfFree } from './db/mappings.js';
import type { UrlMapping } from './db/schema.js';
import { isReservedCode } from './reserved.js';
import { shortCodeFor } from './short-code.js';

/**
 * How many codes one request will try before giving up.
 *
 * Each attempt costs a round-trip, so this bounds worst-case write latency as
 * much as it bounds work. Five is generous: a collision needs the code to be
 * occupied, so the per-attempt failure probability is the table's fill ratio —
 * about 0.5% after five years at the design's write rate (design §2). Five
 * consecutive collisions is then ~3 × 10⁻¹², and reaching this limit means
 * something is wrong with the assumptions rather than that a request was
 * unlucky.
 */
export const MAX_CODE_ATTEMPTS = 5;

export type ShortenOutcome =
  | { outcome: 'created'; mapping: UrlMapping }
  | { outcome: 'existing'; mapping: UrlMapping }
  | { outcome: 'exhausted'; attempts: number; codes: string[] };

/**
 * Stores `canonicalUrl`, or finds the mapping that already stores it.
 *
 * Deduplication falls out of determinism rather than being enforced by a
 * constraint: `shortCodeFor` walks the same probe sequence for a given URL
 * every time, so a re-submission arrives at the row it created earlier and
 * recognizes it by comparing destinations. There is deliberately no unique
 * index on `long_url` — it would be a second index on the write path, on a
 * 2 KB text column, to enforce something the code derivation already gives us.
 */
export async function shortenUrl(canonicalUrl: string): Promise<ShortenOutcome> {
  const attempted: string[] = [];

  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    const shortCode = shortCodeFor(canonicalUrl, attempt);
    attempted.push(shortCode);

    // A generated code is seven Base62 characters and so is `shorten`, so the
    // reserved list is a property of the namespace rather than of the alias
    // endpoint (`reserved.ts`). One in 3.5 trillion, and the fix is to treat it
    // as occupied and re-hash past it — which is what the loop below already
    // does for a code somebody else holds.
    if (isReservedCode(shortCode)) continue;

    const inserted = await insertMappingIfFree({ shortCode, longUrl: canonicalUrl });
    if (inserted !== undefined) {
      // The code may have been asked for before it existed, and the read path
      // caches that "no such code" answer (ADR 0009). Dropping the entry here
      // is what keeps a link from answering 404 for the rest of a negative
      // TTL immediately after being created. Best-effort — if Redis is
      // unreachable this is a no-op and the short negative TTL is the backstop.
      await invalidateCachedTarget(shortCode);

      return { outcome: 'created', mapping: inserted };
    }

    // The code is taken. By whom decides whether this is a collision or a
    // duplicate submission, and only reading the row can tell us — the insert
    // conflicted either way.
    const occupant = await findMappingByCode(shortCode);

    // No invalidation on this branch: the row already existed, nothing about
    // it changed, and whatever the cache holds for the code is still true.
    if (occupant !== undefined && occupant.longUrl === canonicalUrl) {
      return { outcome: 'existing', mapping: occupant };
    }

    // `occupant === undefined` means the row was deleted between the insert and
    // this read — a Phase 6 expiry sweep, or someone at a psql prompt. Treating
    // it as a collision rather than retrying the same attempt keeps the loop
    // bounded; the cost is that the URL settles on its second-choice code.
  }

  return { outcome: 'exhausted', attempts: MAX_CODE_ATTEMPTS, codes: attempted };
}

/**
 * How many times a claim will re-try an alias that vanished under it.
 *
 * Not a collision retry — there is nothing to retry a chosen code *with*. This
 * covers one narrow race: the insert conflicts, and by the time we read the
 * occupant to find out who holds the code, the row is gone (a Phase 6 sweep, a
 * takedown, someone at a psql prompt). Reporting "taken" there would be a false
 * negative about a code that is free, so we go around once more; twice is
 * enough, because a caller losing this race twice is indistinguishable from a
 * caller who is genuinely too late.
 */
const ALIAS_CLAIM_ATTEMPTS = 2;

export type AliasClaim =
  | { outcome: 'created'; mapping: UrlMapping }
  | { outcome: 'existing'; mapping: UrlMapping }
  | { outcome: 'taken' };

/**
 * Claims `alias` for `canonicalUrl`, if it is free.
 *
 * The atomic primitive is the one the generated path already uses —
 * `INSERT ... ON CONFLICT DO NOTHING` against the primary key (design §6) — and
 * it is what makes the claim race-free without a lock or a transaction. The
 * read-then-insert alternative has a window in which two requests both see the
 * alias free, and the loser of that race silently overwrites a link the winner
 * has already handed out. Here the loser gets an empty result and is told the
 * alias is taken, which is the truth.
 *
 * What differs from `shortenUrl` is what happens on conflict, and it is not an
 * omission that there is no retry loop: a generated code that collides can be
 * re-derived, because the user did not ask for that string — they asked for *a*
 * link. An alias that collides cannot. `mylink` is the request, and the only
 * honest answers are "you have it" and "somebody else does".
 *
 * The third answer is `existing`, and it is what makes a retried request safe.
 * The same alias for the same destination is the request that was already
 * satisfied — by an earlier attempt whose response was lost, or by the same
 * user clicking twice — so it succeeds rather than reporting a conflict with
 * itself. Note the test is the *destination*, not who created the row: an alias
 * pointing where you asked it to point is the outcome you wanted, even in the
 * unlikely case that the row was generated rather than claimed. It is also why
 * `isCustom` is in the response — the mapping you get back can tell you which.
 */
export async function claimAlias(
  alias: string,
  canonicalUrl: string,
): Promise<AliasClaim> {
  for (let attempt = 0; attempt < ALIAS_CLAIM_ATTEMPTS; attempt += 1) {
    const inserted = await insertMappingIfFree({
      shortCode: alias,
      longUrl: canonicalUrl,
      isCustom: true,
    });

    if (inserted !== undefined) {
      // Same reason as the generated path: the read path caches "no such code"
      // (ADR 0009), and an alias is far more likely than a generated code to
      // have been tried before it existed — a chosen name is one people guess.
      await invalidateCachedTarget(alias);

      return { outcome: 'created', mapping: inserted };
    }

    const occupant = await findMappingByCode(alias);

    if (occupant !== undefined) {
      return occupant.longUrl === canonicalUrl
        ? { outcome: 'existing', mapping: occupant }
        : { outcome: 'taken' };
    }

    // The row was deleted between the insert and this read. Go around once.
  }

  return { outcome: 'taken' };
}
