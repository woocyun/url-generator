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

export const env = {
  port: readPort('API_PORT', 4000),
  host: process.env.API_HOST ?? '0.0.0.0',
  nodeEnv: process.env.NODE_ENV ?? 'development',
} as const;
