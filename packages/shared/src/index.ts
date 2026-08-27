/**
 * Types shared between the API service and the Next.js web app.
 *
 * This package is consumed as TypeScript source rather than as a build
 * artifact: the API runs it through `tsx`, and Next.js compiles it via
 * `transpilePackages`. That keeps the workspace free of a build step while
 * both services stay on a single source of truth for the wire format.
 */

/** Response body of `GET /health` on the API service. */
export interface HealthResponse {
  status: 'ok' | 'degraded';
  service: string;
  version: string;
  uptimeSeconds: number;
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
