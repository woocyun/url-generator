/**
 * The redirect cache: what the read path keeps in Redis, and for how long.
 *
 * Cache-aside, per ADR 0009. Reads consult this first and fall through to
 * Postgres on a miss; the write path invalidates. Nothing here throws — every
 * function swallows its failures and reports "not cached", because the caller's
 * correct behaviour on a broken cache and on an empty one is identical, and a
 * cache that can raise is a cache that can take the read path down with it.
 *
 * What is stored is `RedirectTarget` — the destination and its expiry, and
 * nothing else. `db/mappings.ts` explains why that shape rather than the row:
 * the columns a redirect decides on never change for the life of the link,
 * while `click_count` changes on every read once Phase 7 lands. Caching only
 * the immutable part is what makes a plain TTL a correct invalidation strategy
 * instead of an approximate one.
 */

import { env } from '../env.js';
import type { RedirectTarget } from '../db/mappings.js';
import { cacheClient } from './client.js';

/**
 * Key prefix, versioned.
 *
 * The `1` is the version of the *value* encoding below. Changing the encoding
 * — adding a field Phase 7 needs, dropping one — means every entry written by
 * the previous release is now a different shape, and a rolling deploy has both
 * releases reading the same keyspace. Bumping the prefix makes the old entries
 * unreachable rather than misread; they expire on their own TTL and nobody has
 * to flush anything.
 */
const KEY_PREFIX = 'u1:';

/**
 * Wire format. Deliberately not `RedirectTarget` verbatim.
 *
 * Field names are one character because they are stored once and read on the
 * hot path — at design §2's read rate the difference between `longUrl` and `u`
 * is bytes off the wire ~11,500 times a second, for a value nothing but this
 * file ever looks at. `e` is epoch milliseconds because JSON has no date and
 * an ISO string would have to be parsed back anyway.
 */
interface CachedEntry {
  /** The destination. Absent on a negative entry. */
  u?: string;
  /** Expiry as epoch milliseconds, or null for a link that never expires. */
  e?: number | null;
  /** Present and true only on a negative entry: this code resolves to nothing. */
  n?: true;
}

/**
 * Three answers, and the caller has to distinguish all three. `miss` means the
 * cache does not know — which is also what it says when it is broken — and
 * `hit-negative` means it knows there is no such code, which is the answer that
 * keeps a scanner off Postgres.
 */
export type CacheLookup =
  | { status: 'hit'; target: RedirectTarget }
  | { status: 'hit-negative' }
  | { status: 'miss' };

/**
 * Looks up a code.
 *
 * A value that does not parse, or parses into a shape this version does not
 * recognize, is treated as a miss and left alone to expire. It should be
 * impossible — the prefix is versioned precisely so two releases cannot write
 * incompatible values under one key — and if it happens anyway, the read path
 * answering correctly and slightly slower is a better failure than the read
 * path throwing.
 */
export async function readCachedTarget(shortCode: string): Promise<CacheLookup> {
  const client = cacheClient();
  if (client === undefined) return { status: 'miss' };

  try {
    const raw = await client.get(KEY_PREFIX + shortCode);
    if (raw === null) return { status: 'miss' };

    const entry = JSON.parse(raw) as CachedEntry;

    if (entry.n === true) return { status: 'hit-negative' };
    if (typeof entry.u !== 'string') return { status: 'miss' };

    return {
      status: 'hit',
      target: {
        longUrl: entry.u,
        expiresAt: typeof entry.e === 'number' ? new Date(entry.e) : null,
      },
    };
  } catch {
    // Unreachable, timed out, or a value we cannot read. All three mean the
    // same thing to the caller: ask Postgres.
    return { status: 'miss' };
  }
}

/**
 * Stores what Postgres just said, including when it said nothing.
 *
 * The negative entry is the half of this that is easy to leave out and
 * expensive to skip. Every path under the API's origin that is not a route
 * reaches the redirect handler, and `looksLikeShortCode` only filters the ones
 * that are not code-shaped — a scanner walking seven-character strings is
 * code-shaped all the way down, and without a negative entry each guess is its
 * own Postgres round-trip, at whatever rate someone cares to send them.
 *
 * The two TTLs differ by two orders of magnitude because the two entries decay
 * differently. A positive entry describes columns that do not change while the
 * row exists, so its TTL is a bound on staleness after a deletion, not a
 * refresh interval. A negative entry describes the *absence* of a row, which
 * any `POST /shorten` can end at any moment — so it is invalidated on write
 * (see `invalidateCachedTarget`) and given a short TTL anyway, because there
 * are two cases the invalidation cannot cover:
 *
 * 1. Redis was unreachable during the write, so the delete never happened.
 * 2. The write interleaved with a read that had already missed. A reader that
 *    queried Postgres before the row existed can be descheduled here, past the
 *    writer's delete, and then write a negative entry for a code that is now
 *    live. It is the standard cache-aside race and it cannot be closed by
 *    ordering alone — closing it needs the reader to hold something across its
 *    own database round-trip, which is a lock on the hot path.
 *
 * Both leave a live link answering 404, so the negative TTL is the real bound
 * on that window: short enough that it reads as a blip, long enough to absorb
 * a scanner walking the code space.
 *
 * An expired link is cached like any other row rather than skipped: it is
 * still what Postgres would say, `resolveShortCode` re-checks the clock on
 * every hit regardless, and a code that has run out is exactly the kind that
 * keeps getting clicked.
 */
export async function cacheTarget(
  shortCode: string,
  target: RedirectTarget | undefined,
): Promise<void> {
  const client = cacheClient();
  if (client === undefined) return;

  const [entry, ttlSeconds]: [CachedEntry, number] =
    target === undefined
      ? [{ n: true }, env.cacheNegativeTtlSeconds]
      : [
          {
            u: target.longUrl,
            e: target.expiresAt === null ? null : target.expiresAt.getTime(),
          },
          env.cacheTtlSeconds,
        ];

  try {
    await client.set(KEY_PREFIX + shortCode, JSON.stringify(entry), 'EX', ttlSeconds);
  } catch {
    // A cache we could not write to is a cache that will miss next time, which
    // is where this request started. Nothing to recover.
  }
}

/**
 * Drops whatever is cached for a code.
 *
 * Called by the write path when it creates a mapping, and the entry it is
 * usually deleting is a negative one: somebody requested the code before it
 * existed — a scanner, a shared link that got out ahead of its creation — and
 * without this, that 404 would stand for the rest of its TTL while the link is
 * live. That window is the reason the negative TTL is short: this delete is
 * best-effort, and when Redis is down during a write it does not happen at all.
 *
 * It is awaited rather than fired and forgotten. The write path is ~1% of
 * traffic (design §2) and has no latency target, so a millisecond is cheap
 * insurance against the common case. It does not close the race — see
 * `cacheTarget` for the interleaving it cannot cover, and why the negative TTL
 * rather than this delete is what bounds the damage.
 */
export async function invalidateCachedTarget(shortCode: string): Promise<void> {
  const client = cacheClient();
  if (client === undefined) return;

  try {
    await client.del(KEY_PREFIX + shortCode);
  } catch {
    // Best-effort by design; the TTL is the backstop.
  }
}
