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

/**
 * Reads a positive integer that may legitimately be absent.
 *
 * Distinct from `readInt` with a fallback because for the two TTL bounds below
 * "unset" is not a number at all — it is the absence of a policy. A default
 * TTL of zero, or a maximum of infinity, would both have to be spelled as
 * numbers that mean "ignore me", and every reader of those values would then
 * have to know the sentinel. `undefined` says it in the type.
 */
function readOptionalInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;

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

  /**
   * How long a link lives when the caller does not say (F4).
   *
   * Unset means links are permanent unless asked otherwise, which is the
   * behaviour every phase before this one had, and it is the right default for
   * a shortener: a link that quietly stops working is worse than one that
   * outlives its usefulness. A deployment with a retention policy sets this and
   * gets it applied to every link created without an explicit `expiresIn`.
   */
  defaultLinkTtlSeconds: readOptionalInt('DEFAULT_LINK_TTL_SECONDS'),

  /**
   * The longest TTL this deployment will issue, including "never".
   *
   * The separate knob is what makes `expiresIn: null` honest. A default is a
   * convenience and a caller is allowed to decline it; a maximum is a policy
   * and a caller is not. Unset means no ceiling, so the two together cover
   * every deployment: none of this configured is a permanent-link service,
   * a default alone nudges, and a maximum enforces.
   */
  maxLinkTtlSeconds: readOptionalInt('MAX_LINK_TTL_SECONDS'),

  /**
   * How long an expired row is kept before the sweep deletes it.
   *
   * This is the lifetime of the 410. `GET /{code}` can only answer "this link
   * existed and ran out" while the row is there to say so; once it is gone the
   * same code is a 404 (ADR 0008). Deleting on the stroke of expiry would make
   * the 410 unobservable in practice — the sweep would erase it within one
   * interval — so the row outlives the link on purpose.
   *
   * A week is long enough that whoever clicks a just-expired link gets told
   * what happened, and short enough that a claimed alias does not stay locked
   * up long after the link using it died.
   */
  expiryRetentionSeconds: readInt('EXPIRY_RETENTION_SECONDS', 604_800),

  /**
   * How often the sweep runs, and how much it removes in one statement.
   *
   * Expiry is enforced on read (`redirect.ts`), so the sweep is storage
   * hygiene rather than correctness and nothing goes wrong if it runs late.
   * That is what licenses the batching: `DELETE` takes a row lock per row, and
   * an unbounded one against a table the read path is using would hold
   * thousands of them for as long as it took.
   */
  expirySweepIntervalSeconds: readInt('EXPIRY_SWEEP_INTERVAL_SECONDS', 300),
  expirySweepBatchSize: readInt('EXPIRY_SWEEP_BATCH_SIZE', 500),

  /**
   * Batches one pass will run before stopping until the next interval.
   *
   * A backlog — the first sweep after this phase ships, or after the job has
   * been down — should be worked through over several passes rather than in
   * one long-running loop that holds a connection and competes with the read
   * path indefinitely. The bound is what makes a pass's cost predictable.
   */
  expirySweepMaxBatches: readInt('EXPIRY_SWEEP_MAX_BATCHES', 20),
} as const;
