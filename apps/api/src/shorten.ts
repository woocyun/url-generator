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
 */

import { findMappingByCode, insertMappingIfFree } from './db/mappings.js';
import type { UrlMapping } from './db/schema.js';
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

    const inserted = await insertMappingIfFree({ shortCode, longUrl: canonicalUrl });
    if (inserted !== undefined) {
      return { outcome: 'created', mapping: inserted };
    }

    // The code is taken. By whom decides whether this is a collision or a
    // duplicate submission, and only reading the row can tell us — the insert
    // conflicted either way.
    const occupant = await findMappingByCode(shortCode);

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
