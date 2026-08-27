/**
 * drizzle-kit configuration.
 *
 * This drives code generation only — `npm run db:generate` diffs the schema and
 * writes SQL into `drizzle/`. Applying those files is a separate job that does
 * not use drizzle-kit at all (see `src/db/migrate.ts` and ADR 0006).
 */

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  // Generation is a local, offline operation, but drizzle-kit insists on
  // credentials being present. The fallback keeps `db:generate` usable without
  // a running database.
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      'postgres://urlshortener:urlshortener@localhost:5432/urlshortener',
  },
  strict: true,
  verbose: true,
});
