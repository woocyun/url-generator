/**
 * Applies pending migrations, then exits.
 *
 * Run as a one-shot job before the API starts, never by the API itself — see
 * ADR 0006. Uses drizzle-orm's migrator rather than the drizzle-kit CLI so the
 * schema tooling stays a development dependency and this stays a plain Node
 * process with an exit code that Compose can gate on.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { env } from '../env.js';

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle',
);

async function main(): Promise<void> {
  // `max: 1` because the migrator must run its statements on one session:
  // Postgres DDL is transactional, and a pool would scatter it across
  // connections.
  const connection = postgres(env.databaseUrl, {
    max: 1,
    connect_timeout: 10,
    // Migrations legitimately raise notices — "already exists, skipping" on a
    // re-run is the idempotent path working. Keep the text, drop the driver's
    // full object dump, which reads like a crash in the container logs.
    onnotice: (notice) => console.log(`notice: ${notice.message}`),
  });

  try {
    console.log(`applying migrations from ${migrationsFolder}`);
    await migrate(drizzle(connection), { migrationsFolder });
    console.log('migrations complete');
  } finally {
    await connection.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  // A failed migration must stop the deploy rather than let the API start
  // against a schema it does not expect.
  console.error('migration failed:', error);
  process.exit(1);
});
