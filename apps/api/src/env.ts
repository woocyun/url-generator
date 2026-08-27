/**
 * Environment parsing for the API service.
 *
 * Config is read once at startup and fails loudly, so a misconfigured
 * container dies immediately instead of surfacing as confusing 500s later.
 */

function readPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`${name} must be a valid port number, got: ${raw}`);
  }
  return parsed;
}

function readRequired(name: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    throw new Error(`${name} is required but was not set`);
  }
  return raw;
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`);
  }
  return parsed;
}

export const env = {
  port: readPort('API_PORT', 4000),
  host: process.env.API_HOST ?? '0.0.0.0',
  nodeEnv: process.env.NODE_ENV ?? 'development',

  /**
   * Required: there is no useful degraded mode for an API whose only job is
   * reading and writing mappings, so a missing connection string is a startup
   * failure rather than something to discover on the first request.
   */
  databaseUrl: readRequired('DATABASE_URL'),

  /**
   * Ceiling on connections held by one API instance. Postgres 18 defaults to
   * 100 total, so this has to leave room for the migrate job, other replicas,
   * and a `psql` session for whoever is debugging.
   */
  databasePoolMax: readInt('DATABASE_POOL_MAX', 10),
} as const;
