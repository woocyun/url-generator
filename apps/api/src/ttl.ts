/**
 * Link lifetimes (design §5, F4): what a caller may ask for, and what it means
 * for a link to have run out.
 *
 * The counterpart to `alias.ts`, and it sits in the same place in the write
 * path: everything here is a property of the request and the deployment's
 * configuration, decided before anything touches the table. Whether a *stored*
 * link has expired is a different question, and `hasExpired` below is the one
 * function that answers it — for the read path, the sweep, and the write path
 * alike, because three places disagreeing about what "expired" means is how a
 * link gets resurrected by one component and buried by another.
 *
 * **The request is a duration; the row holds an instant.** A TTL is naturally a
 * duration, the deployment default is a duration, and the conversion happens
 * once, here, against the clock the read path will later compare against. An
 * absolute `expiresAt` on the wire would be the same value measured on the
 * caller's clock and re-judged on ours — a link that arrives already expired
 * because a laptop is four minutes fast is a bug report nobody can reproduce.
 * The response carries the resolved instant, so the caller never has to guess
 * what we computed.
 */

import { env } from './env.js';

/**
 * Shortest link we will issue.
 *
 * One second, and the bound exists to exclude zero and everything below it
 * rather than to express a policy. A link created already expired is a request
 * to store a row whose only possible answer is 410, and answering "that is not
 * a duration" is more useful than storing it.
 */
export const MIN_LINK_TTL_SECONDS = 1;

/**
 * What the caller asked for.
 *
 * Three states, one field, and they are genuinely different requests:
 *
 *   number     this link lives that many seconds
 *   null       this link never expires — decline the deployment's default
 *   undefined  no opinion; whatever the deployment does by default
 *
 * `undefined` and `null` collapsing into one another is exactly the bug this
 * shape exists to prevent, which is also why the API rejects unknown body
 * fields and does not coerce types (`index.ts`): a client that sends
 * `expiresIn: "3600"` should be told, not quietly given a permanent link.
 */
export type RequestedTtl = number | null | undefined;

export type ExpiryResult =
  | { ok: true; expiresAt: Date | null }
  | { ok: false; code: string; message: string };

/**
 * Turns a requested TTL into the instant to store, or says why we will not.
 *
 * One error code for every rejection rather than one per bound. Both a TTL of
 * zero and a TTL above the deployment's ceiling are the same thing to the
 * client — a number to change — and the message names the bound that was
 * missed. This differs from `alias.ts`, which returns two codes, because there
 * the two rejections call for different actions: a reserved alias is never
 * available and a taken one might be. Every TTL rejection here is answered by
 * sending a different number.
 */
export function resolveExpiry(
  requested: RequestedTtl,
  now: Date = new Date(),
): ExpiryResult {
  const max = env.maxLinkTtlSeconds;

  // Explicitly permanent. Allowed unless the deployment has a ceiling, in
  // which case "never" is simply the largest TTL there is and it is over the
  // limit — the same rejection a number above the ceiling gets, for the same
  // reason.
  if (requested === null) {
    if (max !== undefined) {
      return {
        ok: false,
        code: 'invalid_ttl',
        message: `links on this service expire within ${max} seconds; expiresIn cannot be null`,
      };
    }

    return { ok: true, expiresAt: null };
  }

  const seconds = requested ?? env.defaultLinkTtlSeconds;

  // No request and no default: a permanent link, which is what every phase
  // before this one produced.
  if (seconds === undefined) return { ok: true, expiresAt: null };

  if (seconds < MIN_LINK_TTL_SECONDS) {
    return {
      ok: false,
      code: 'invalid_ttl',
      message: `expiresIn must be at least ${MIN_LINK_TTL_SECONDS} second, got ${seconds}`,
    };
  }

  // The ceiling is not applied to the default, only to what a caller asks for.
  // A deployment that configures a default above its own maximum has
  // misconfigured itself, and clamping would hide that; the check below is on
  // `requested` so the operator's mistake surfaces as links that outlive the
  // policy rather than as 400s to callers who asked for nothing.
  if (max !== undefined && requested !== undefined && requested > max) {
    return {
      ok: false,
      code: 'invalid_ttl',
      message: `expiresIn must be at most ${max} seconds, got ${requested}`,
    };
  }

  return { ok: true, expiresAt: new Date(now.getTime() + seconds * 1_000) };
}

/**
 * Whether a stored link has run out.
 *
 * NULL means never (design §6). The comparison is inclusive so a link is dead
 * at its expiry instant rather than one millisecond after it, which matters
 * only to a test but costs nothing to be right about.
 *
 * The clock is this process's, not Postgres's. Both columns are `timestamptz`
 * so the comparison is absolute rather than zone-dependent, and a link
 * surviving a few seconds of clock skew past its TTL is not a correctness
 * problem: expiry is a lifecycle bound, not an access control. Nothing here is
 * keeping a secret — the destination was already handed out to whoever holds
 * the link.
 */
export function hasExpired(expiresAt: Date | null, now: Date = new Date()): boolean {
  return expiresAt !== null && expiresAt.getTime() <= now.getTime();
}
