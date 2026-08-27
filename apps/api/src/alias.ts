/**
 * Validation for a user-chosen short code (design §5, F3).
 *
 * The counterpart to `url.ts`: that file decides what we will redirect *to*,
 * this one decides what we will redirect *from*. The asymmetry between them is
 * the interesting part. A destination is the user's to name and we normalize it
 * as little as we can get away with; an alias is a claim on a shared namespace
 * we hand out once and cannot take back without breaking a link somebody has
 * already sent to somebody else. So this file is the stricter of the two, and
 * it is strict in the direction that is cheap to relax later.
 *
 * Everything here is a property of the string alone. Whether the alias is
 * *available* is a question about the table, and only the table can answer it —
 * see `claimAlias` in `shorten.ts`.
 */

import { isReservedCode } from './reserved.js';
import { MAX_SHORT_CODE_LENGTH } from './short-code.js';

/**
 * Shortest alias we will hand out.
 *
 * Not a technical limit — one character is a perfectly good primary key. It is
 * a decision about a scarce resource: there are 3,906 one- and two-character
 * Base62 strings in total, they are the most valuable codes the service will
 * ever have, and first-come-first-served means they belong to whoever scripts
 * fastest rather than to anyone the service chose.
 *
 * Held back rather than forbidden, and the asymmetry is the whole argument:
 * lowering this number later costs nothing, while raising it means reclaiming
 * codes that are already live links.
 */
export const MIN_ALIAS_LENGTH = 3;

/**
 * Longest alias, which is the `short_code` column's width rather than a number
 * of its own (design §6). An alias is a code; the namespace has one bound.
 */
export const MAX_ALIAS_LENGTH = MAX_SHORT_CODE_LENGTH;

/**
 * Base62 plus `-` and `_`.
 *
 * A superset of what generated codes use, because the two share a namespace and
 * a chosen code should be able to be a word — `launch-notes` is the reason
 * anyone asks for this feature, and `launchnotes` is a worse link.
 *
 * A strict subset of what is safe in a URL path, though, and it is worth
 * naming what is excluded and why:
 *
 *   `.`  would make `favicon.ico` and `robots.txt` claimable, and those are
 *        requested by browsers rather than followed by people.
 *   `%`  would let one alias be spelled two ways, so `/a%2Fb` and `/a/b` are a
 *        uniqueness question the primary key cannot see.
 *   `/`  is a path separator; an alias containing one is a different route.
 *   non-ASCII would make two visually identical aliases distinct rows, which is
 *        the homograph problem with the confusion built into the product.
 *
 * The general rule: a code is a thing people copy off a screen and type into a
 * different device, and every character here survives that trip.
 */
const ALIAS_PATTERN = /^[0-9A-Za-z_-]+$/;

export type AliasResult =
  | { ok: true; alias: string }
  | { ok: false; code: string; message: string };

/**
 * Checks a requested alias, returning the string to claim or why we will not.
 *
 * **Case is preserved, not folded.** Generated codes are case-sensitive Base62
 * (`wYx0ePz`), aliases live in the same namespace, and one namespace gets one
 * uniqueness rule. Folding aliases to lowercase would mean `Launch` and
 * `launch` are the same claim while `wYx0ePz` and `wyx0epz` are not, and
 * enforcing that would need a unique index on `lower(short_code)` — a second
 * index on the table whose only index is deliberately its primary key
 * (design §6), to make one half of the namespace behave unlike the other.
 *
 * The cost is real and worth stating: `/Launch` and `/launch` can be two
 * different links, so a mistyped capital is a 404 rather than a redirect. That
 * is already true of every code the service has issued since Phase 2.
 *
 * `isReservedCode` folds case for its own comparison, which is the one place
 * that should — see `reserved.ts`.
 */
export function validateAlias(input: string): AliasResult {
  // Trimmed for the same reason `canonicalizeUrl` trims: whitespace around a
  // pasted value is an artifact of the paste, and no valid alias contains any,
  // so this can only turn a rejection into what the user meant.
  const alias = input.trim();

  if (alias.length < MIN_ALIAS_LENGTH || alias.length > MAX_ALIAS_LENGTH) {
    return {
      ok: false,
      code: 'invalid_alias',
      message: `alias must be between ${MIN_ALIAS_LENGTH} and ${MAX_ALIAS_LENGTH} characters, got ${alias.length}`,
    };
  }

  if (!ALIAS_PATTERN.test(alias)) {
    return {
      ok: false,
      code: 'invalid_alias',
      message: 'alias may contain only letters, digits, hyphens and underscores',
    };
  }

  // Distinct from `alias_taken`, and the difference is not pedantry: this one
  // is a permanent property of the string and no amount of waiting will change
  // it, which is why it is a 400 at the route rather than a 409. See ADR 0010.
  if (isReservedCode(alias)) {
    return {
      ok: false,
      code: 'alias_reserved',
      message: `alias "${alias}" is reserved and cannot be claimed`,
    };
  }

  return { ok: true, alias };
}
