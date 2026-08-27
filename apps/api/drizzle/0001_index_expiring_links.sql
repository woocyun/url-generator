-- The partial index the expiry sweep reads (ADR 0011). Partial because
-- permanent links are the common case and a full index would carry a NULL
-- entry for every one of them.
--
-- Not CONCURRENTLY: the migrator runs each file in a transaction (ADR 0006)
-- and CREATE INDEX CONCURRENTLY cannot run inside one. It takes a write lock
-- on url_mappings for as long as the build takes, which is nothing on a table
-- this size and would not be on a large one. Building it concurrently by hand
-- before deploying is the answer there, and the migration is then a no-op.
CREATE INDEX "url_mappings_expires_at_idx" ON "url_mappings" USING btree ("expires_at") WHERE "url_mappings"."expires_at" is not null;
