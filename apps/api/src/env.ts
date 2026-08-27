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

/**
 * Reads a `redis://` connection string, if one is configured.
 *
 * Optional where `DATABASE_URL` is required, and the asymmetry is the design
 * (ADR 0009): the API has no correct behaviour without Postgres, and it has
 * fully correct — merely slower — behaviour without Redis. Unset means run
 * without a cache, which is what `npm run dev` outside Compose does.
 */
function readCacheUrl(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute url, got: ${raw}`);
  }

  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error(
      `${name} must be a redis:// or rediss:// url, got: ${parsed.protocol.replace(':', '')}`,
    );
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

  /**
   * Optional: unset runs the read path straight against Postgres, which is
   * Phase 3's behaviour and still correct. See `readCacheUrl`.
   */
  redisUrl: readCacheUrl('REDIS_URL'),

  /**
   * How long a resolved mapping stays cached.
   *
   * Not a refresh interval — the cached columns do not change while the row
   * exists (`db/mappings.ts`) — but a bound on how long a *deleted* row can
   * still be served, since nothing but Phase 6's sweep and a takedown removes
   * one and neither goes through this process. An hour keeps a viral link warm
   * across a whole traffic spike while keeping the worst-case staleness short
   * enough to explain to whoever asked for the takedown.
   */
  cacheTtlSeconds: readInt('CACHE_TTL_SECONDS', 3_600),

  /**
   * How long "there is no such code" stays cached.
   *
   * Two orders of magnitude shorter, because this one describes an absence
   * that any `POST /shorten` can end. The write path deletes the entry when it
   * creates the code, so this TTL only has to cover the case where Redis was
   * unreachable during that write — short enough that the window is a blip,
   * long enough to absorb a scanner walking the code space.
   */
  cacheNegativeTtlSeconds: readInt('CACHE_NEGATIVE_TTL_SECONDS', 30),
} as const;
