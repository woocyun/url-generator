import type { HealthResponse } from '@url-generator/shared';

// Phase 1 has nothing to cache yet, and the whole point of this page is to
// show the API's *current* state, so opt out of caching entirely.
export const dynamic = 'force-dynamic';

const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://api:4000';

async function fetchHealth(): Promise<HealthResponse | null> {
  try {
    const response = await fetch(`${API_INTERNAL_URL}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    return (await response.json()) as HealthResponse;
  } catch {
    // The API container may still be starting; render the down state rather
    // than crashing the page.
    return null;
  }
}

export default async function HomePage() {
  const health = await fetchHealth();
  const database = health?.dependencies.database;

  return (
    <main>
      <h1>URL Generator</h1>
      <p style={{ color: 'var(--muted)' }}>
        A URL shortener built step by step. Phase 1: the schema is in place and
        the API reports on the database it depends on.
      </p>

      <h2>API status</h2>
      {health ? (
        <dl>
          <dt>Status</dt>
          <dd style={{ color: health.status === 'ok' ? 'var(--ok)' : 'var(--bad)' }}>
            {health.status}
          </dd>
          <dt>Service</dt>
          <dd>{health.service}</dd>
          <dt>Version</dt>
          <dd>{health.version}</dd>
          <dt>Uptime</dt>
          <dd>{health.uptimeSeconds}s</dd>
          <dt>Database</dt>
          <dd
            style={{
              color: database?.status === 'ok' ? 'var(--ok)' : 'var(--bad)',
            }}
          >
            {database?.status ?? 'unknown'}
            {database ? ` (${database.latencyMs}ms)` : ''}
            {database?.error ? ` — ${database.error}` : ''}
          </dd>
        </dl>
      ) : (
        <p style={{ color: 'var(--bad)' }}>
          Could not reach the API at <code>{API_INTERNAL_URL}</code>.
        </p>
      )}
    </main>
  );
}
