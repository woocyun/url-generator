/**
 * API entry point: build the server, mount the routes, run it.
 *
 * Routes live in `routes/` and are registered here. The split is not
 * housekeeping — design §3 keeps the write path and the read path separable so
 * that running them as two services later is a configuration change rather than
 * a rewrite, and that only stays true if they never grow into each other.
 */

import Fastify from 'fastify';
import { closeDatabase } from './db/client.js';
import { env } from './env.js';
import { registerErrorHandlers } from './errors.js';
import { healthRoutes } from './routes/health.js';
import { shortenRoutes } from './routes/shorten.js';

const app = Fastify({
  logger: {
    level: env.nodeEnv === 'production' ? 'info' : 'debug',
  },

  // Two of Fastify's ajv defaults are wrong for an API whose input is a URL
  // someone will paste from anywhere.
  //
  //   coerceTypes      turns `{"url": 42}` into the string "42", which then
  //                    canonicalizes to https://0.0.0.42/ — a request that was
  //                    plainly malformed becomes a stored mapping.
  //   removeAdditional silently deletes properties the schema does not declare,
  //                    so a client sending `customAlias` before Phase 5 exists
  //                    gets a 201 and a generated code, and no hint that the
  //                    field went in the bin.
  //
  // Both defaults trade a clear rejection for a plausible-looking wrong answer.
  ajv: {
    customOptions: {
      coerceTypes: false,
      removeAdditional: false,
    },
  },
});

registerErrorHandlers(app);

await app.register(healthRoutes);
await app.register(shortenRoutes);

async function start(): Promise<void> {
  try {
    await app.listen({ port: env.port, host: env.host });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

// Compose sends SIGTERM on `docker compose down`; close connections cleanly so
// in-flight requests are not severed mid-response and Postgres is not left
// holding sessions nobody is on the other end of.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    app.log.info(`received ${signal}, shutting down`);
    void app
      .close()
      .then(() => closeDatabase())
      .then(() => process.exit(0));
  });
}

void start();
