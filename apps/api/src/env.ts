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

/**
 * Reads an origin the outside world can reach us on, with the trailing slash
 * normalized away so callers can join paths with a plain `/`.
 */
function readBaseUrl(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;

  try {
    new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute url, got: ${raw}`);
  }

  return raw.replace(/\/+$/, '');
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

  /**
   * The origin short links are handed out under, used to build the `shortUrl`
   * in a create response. It is configuration rather than something derived
   * from the request's `Host` header: behind a proxy that header is
   * attacker-controlled, and a shortener that will mint links pointing at
   * whatever host a caller claims is a redirect gadget.
   *
   * Defaults to the API's own local port, because the API is what serves
   * `GET /{code}` from Phase 3.
   */
  publicBaseUrl: readBaseUrl(
    'PUBLIC_BASE_URL',
    `http://localhost:${readPort('API_PORT', 4000)}`,
  ),
} as const;
