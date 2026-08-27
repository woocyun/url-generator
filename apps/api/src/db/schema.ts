/**
 * Database schema.
 *
 * The tables here follow the data model sketched in `docs/design.md` §6. This
 * phase creates the storage; the phases that use it fill in the behaviour.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * One short code, one destination.
 *
 * `short_code` is the primary key rather than a surrogate ID, which buys two
 * things the design depends on:
 *
 * 1. The redirect path (Phase 3) is a primary-key lookup — the hot path never
 *    touches a secondary index.
 * 2. The uniqueness constraint is the atomic "claim this code if it is free"
 *    primitive. `INSERT ... ON CONFLICT DO NOTHING` resolves hash collisions
 *    (Phase 2) and custom-alias races (Phase 5) without a read-then-write
 *    window for two writers to slip through.
 *
 * See ADR 0002 for why this is Postgres and ADR 0003 for how codes are made.
 */
export const urlMappings = pgTable('url_mappings', {
  /**
   * Base62 code from the URL path. Generated codes are 7 characters (ADR 0003),
   * and the column is wider because custom aliases share this namespace: 3 to
   * 32 characters of `[A-Za-z0-9_-]`, case-sensitive like everything else here
   * (ADR 0010). One column, one primary key, one uniqueness rule.
   */
  shortCode: varchar('short_code', { length: 32 }).primaryKey(),

  /**
   * The canonicalized destination. Unbounded here because the length limit is a
   * request-validation concern (Phase 2) — the database should not be the thing
   * that decides a URL is too long.
   */
  longUrl: text('long_url').notNull(),

  /**
   * Creator, once there are accounts. Nullable and without a foreign key: the
   * `users` table is deferred until something needs it, and anonymous links
   * stay legal regardless.
   */
  userId: uuid('user_id'),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),

  /**
   * NULL means the link never expires (F4). Set on the write path from the
   * caller's `expiresIn` or the deployment's default (`ttl.ts`), read by
   * `redirect.ts` on every resolution, and by the sweep that eventually deletes
   * the row. Never updated for a live link — see ADR 0011.
   */
  expiresAt: timestamp('expires_at', { withTimezone: true }),

  /**
   * Maintained by Phase 7. `bigint` rather than `integer` because a single link
   * that goes viral is exactly the case worth surviving, and 2.1 billion is a
   * reachable number for one row on the read side of a 100:1 workload.
   */
  clickCount: bigint('click_count', { mode: 'number' })
    .notNull()
    .default(sql`0`),

  /**
   * Distinguishes a user-chosen alias from a generated code (ADR 0010). Set on
   * the claim and never updated: once both are rows in one namespace, this is
   * the only thing that tells them apart, and it is on the wire for the same
   * reason — a caller that asked for an alias and got `created: false,
   * isCustom: false` collided with a generated mapping for the same
   * destination. Phase 7 splits click statistics on it.
   */
  isCustom: boolean('is_custom').notNull().default(false),
},
(table) => [
  /**
   * The second index on this table, and the first one that is not the primary
   * key. It exists for exactly one query: the sweep's "which rows expired
   * before this instant" (`deleteExpiredBefore`). Design §6 deferred it to
   * this phase deliberately, so that no index sat here without a caller.
   *
   * Partial, on `expires_at is not null`, and that is the whole reason it is
   * affordable. Permanent links are the common case — the default TTL is unset
   * unless a deployment opts in — and a full index would carry a NULL entry for
   * every one of them: dead weight in the index, and a write-path cost on the
   * 115 inserts a second design §2 budgets for. The partial index is
   * proportional to the number of links that can actually expire, and rows
   * that will never interest the sweep are not in it at all.
   */
  index('url_mappings_expires_at_idx')
    .on(table.expiresAt)
    .where(sql`${table.expiresAt} is not null`),
]);

export type UrlMapping = typeof urlMappings.$inferSelect;
export type NewUrlMapping = typeof urlMappings.$inferInsert;
