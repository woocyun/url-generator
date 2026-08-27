/**
 * Short code generation: hash the canonical URL, truncate the digest, encode
 * Base62 (ADR 0003).
 *
 * ADR 0003 left three specifics to this phase — the digest, the truncation
 * width, and how a collision is resolved. They are settled here and recorded in
 * ADR 0007.
 *
 * Generation is pure and stateless: no counter, no worker ID, no clock. That is
 * the property the strategy was chosen for, and it is what lets the retry loop
 * in `shorten.ts` run concurrently on any number of API instances without
 * coordination.
 */

import { createHash } from 'node:crypto';

/**
 * Base62 alphabet. The digit order is arbitrary but frozen: changing it would
 * re-map every code generated from here on, and every URL already in the table
 * would hash to a code that is not the one storing it — silently breaking
 * deduplication rather than failing loudly.
 */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Seven characters, per the estimate in design §2: 62⁷ ≈ 3.52 × 10¹² codes
 * against 3.65 × 10⁹ new URLs a year is decades of headroom.
 */
export const SHORT_CODE_LENGTH = 7;

/** 62⁷ — how many distinct codes a 7-character string can hold. */
const CODE_SPACE = BigInt(ALPHABET.length) ** BigInt(SHORT_CODE_LENGTH);

/**
 * SHA-256, rather than the reference design's MD5.
 *
 * Truncation, not the digest, is what makes collisions likely here, so MD5's
 * broken collision resistance barely moves the arithmetic. It is still the
 * wrong default: MD5 is unavailable under a FIPS-restricted OpenSSL, it invites
 * the "why is there an MD5 in this codebase" question at every future review,
 * and being able to *craft* two URLs that share a code — rather than merely
 * stumble into one — turns an accounted-for retry into something an attacker
 * can schedule. SHA-256 costs microseconds on a path that is already spending a
 * database round-trip.
 */
const DIGEST = 'sha256';

/**
 * How many leading digest bytes are folded into the code.
 *
 * Eight bytes is 64 bits of entropy reduced mod 62⁷ (≈ 41.7 bits). The
 * reduction is biased — 2⁶⁴ is not a multiple of 62⁷ — but by one extra chance
 * in ~5.2 million per residue, four orders of magnitude below the truncation
 * collision rate it sits inside.
 */
const TRUNCATION_BYTES = 8;

/**
 * Separator between the URL and the attempt number.
 *
 * A NUL byte cannot appear in a canonicalized URL — the parser percent-encodes
 * it — so `(url, 1)` and `(url + "1", 0)` cannot be made to hash alike.
 */
const ATTEMPT_SEPARATOR = '\u0000';

/**
 * Fixed-width Base62. `0` is the zero digit, so leading zeros are the natural
 * representation of a small value rather than padding bolted on afterwards.
 */
function encodeBase62(value: bigint): string {
  const base = BigInt(ALPHABET.length);
  let remaining = value;
  let code = '';

  for (let i = 0; i < SHORT_CODE_LENGTH; i += 1) {
    code = ALPHABET[Number(remaining % base)] + code;
    remaining /= base;
  }

  return code;
}

/**
 * The code for `canonicalUrl` on a given attempt.
 *
 * Collisions are resolved by re-hashing with the attempt number mixed in rather
 * than by appending a suffix, which keeps every code exactly
 * `SHORT_CODE_LENGTH` characters and — more importantly — keeps the probe
 * sequence deterministic: attempt _n_ for a URL is always the same code.
 * Re-submitting a URL therefore walks the identical sequence and finds its own
 * row, so deduplication keeps working even for a URL that had to be displaced.
 * A random salt would generate a fresh code and a duplicate row instead.
 */
export function shortCodeFor(canonicalUrl: string, attempt = 0): string {
  const material =
    attempt === 0 ? canonicalUrl : `${canonicalUrl}${ATTEMPT_SEPARATOR}${attempt}`;

  const digest = createHash(DIGEST).update(material, 'utf8').digest();
  const truncated = digest.subarray(0, TRUNCATION_BYTES).readBigUInt64BE(0);

  return encodeBase62(truncated % CODE_SPACE);
}

/**
 * The widest string the read path will take to the database.
 *
 * It is the `short_code` column's width (design §6), not the generated code
 * length: custom aliases share this namespace, and a lookup that rejected
 * anything longer than seven characters would have to be revisited the moment
 * they land. Exported because `alias.ts` bounds a chosen code by the same
 * column rather than by a second number that could drift from it.
 */
export const MAX_SHORT_CODE_LENGTH = 32;

/**
 * Base62, plus the two separators a custom alias wants.
 *
 * Deliberately looser than what `shortCodeFor` emits, and now a strict superset
 * of what `alias.ts` accepts as well — which is why Phase 5 landed without
 * touching the read path at all. Its job is not validation: it is the shape
 * test that keeps `/favicon.ico` off the database.
 */
const SHORT_CODE_PATTERN = new RegExp(`^[0-9A-Za-z_-]{1,${MAX_SHORT_CODE_LENGTH}}$`);

/**
 * Whether `value` could be a short code at all.
 *
 * This is an optimization, not validation, and the distinction decides the
 * status code. Every path under the API's origin that is not a declared route
 * reaches the redirect handler — `/favicon.ico`, `/robots.txt`, `/.env`, a
 * crawler's guesses — and none of them can be a code. Answering them from the
 * pattern keeps the hot path's database round-trips proportional to real
 * traffic rather than to what points at the origin.
 *
 * Because it is not validation, a string that fails here gets the same 404 as a
 * code that is merely unknown: to whoever followed the link, both are "no such
 * link", and a 400 would be blaming the client for a URL it did not compose.
 */
export function looksLikeShortCode(value: string): boolean {
  return SHORT_CODE_PATTERN.test(value);
}
