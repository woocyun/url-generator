/**
 * Types shared between the API service and the Next.js web app.
 *
 * This package is consumed as TypeScript source rather than as a build
 * artifact: the API runs it through `tsx`, and Next.js compiles it via
 * `transpilePackages`. That keeps the workspace free of a build step while
 * both services stay on a single source of truth for the wire format.
 */

/** Health of one thing the API depends on. */
export interface DependencyHealth {
  status: 'ok' | 'unreachable';
  /** Round-trip time of the probe, including the time spent failing. */
  latencyMs: number;
  /** Present only when `status` is `unreachable`. */
  error?: string;
}

/**
 * Health of the cache.
 *
 * Separate from `DependencyHealth` because it has a third state the others do
 * not: the cache is optional, and a deployment that runs without one is
 * configured rather than broken. `disabled` is not `unreachable`, and only the
 * latter degrades the service.
 */
export interface CacheHealth {
  status: 'ok' | 'unreachable' | 'disabled';
  /** Round-trip time of the probe. Absent when the cache is `disabled`. */
  latencyMs?: number;
  /** Present only when `status` is `unreachable`. */
  error?: string;
}

/**
 * Response body of `GET /health` on the API service.
 *
 * `status` is `degraded` when the process is up but something it depends on is
 * not. The endpoint still answers 200 in that case: it reports liveness, and an
 * orchestrator should not restart a healthy API because the database blinked —
 * still less because the cache did, since the read path is correct without it.
 */
export interface HealthResponse {
  status: 'ok' | 'degraded';
  service: string;
  version: string;
  uptimeSeconds: number;
  dependencies: {
    database: DependencyHealth;
    cache: CacheHealth;
  };
}

/**
 * Error shape returned by every API endpoint that fails.
 *
 * `code` is a stable machine-readable string so the web app can branch on it
 * without parsing prose; `message` is for humans.
 */
export interface ApiError {
  code: string;
  message: string;
}

/**
 * Request body of `POST /shorten`.
 *
 * `url` is the raw destination as the user typed it. The API canonicalizes it
 * before hashing, so the value stored and returned may differ from what was
 * sent — see `ShortenResponse.longUrl`.
 */
export interface ShortenRequest {
  url: string;
  /**
   * A code to claim instead of generating one (F3).
   *
   * Optional, and omitting it is the ordinary path. Supplying it changes the
   * failure modes rather than the shape of the answer: an alias can be
   * malformed or reserved (400), or already held by a different destination
   * (409), where a generated code simply retries past a collision. 3–32
   * characters of `[A-Za-z0-9_-]`, case-sensitive.
   */
  customAlias?: string;
}

/**
 * Response body of `POST /shorten`.
 *
 * Short codes are derived from the URL rather than allocated (ADR 0003), so
 * submitting the same destination twice returns the same code and stores one
 * row. That makes deduplication observable, and the contract has to be explicit
 * about it: `createdAt` may be older than the request, and the status code says
 * which happened — 201 for a mapping this request created, 200 for one that
 * already existed.
 *
 * Deduplication is a property of the *generated* path only. A custom alias is a
 * second name for a destination that may already have one, so one URL can have
 * any number of codes once F3 is in play — which is why `shortCode` is the
 * identity here and the URL is not.
 */
export interface ShortenResponse {
  /** Base62 code that identifies the mapping. */
  shortCode: string;
  /** The full short URL, built from the API's public base URL. */
  shortUrl: string;
  /** The canonicalized destination, which is what a redirect will send to. */
  longUrl: string;
  /** When the mapping was first created — not necessarily by this request. */
  createdAt: string;
  /** False when an identical URL had already been shortened. */
  created: boolean;
  /**
   * True when the code was chosen by a caller rather than derived from the URL.
   *
   * Worth having on the wire because `created: false` alone does not say what
   * you collided with: an alias request that comes back `created: false,
   * isCustom: false` matched a generated mapping that already pointed at the
   * same destination.
   */
  isCustom: boolean;
}
