import type { HealthResponse } from '@url-generator/shared';

// Phase 0 has nothing to cache yet, and the whole point of this page is to
// show the API's *current* state, so opt out of caching entirely.
export const dynamic = 'force-dynamic';

const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://api:4000';

async function fetchHealth(): Promise<HealthResponse | null> {
  try {
    const response = await fetch(`${API_INTERNAL_URL}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
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

  return (
    <main>
      <h1>URL Generator</h1>
      <p style={{ color: 'var(--muted)' }}>
        A URL shortener built step by step. Phase 0: the services are wired
        together and talking to each other.
      </p>

      <h2>API status</h2>
      {health ? (
        <dl>
          <dt>Status</dt>
          <dd style={{ color: 'var(--ok)' }}>{health.status}</dd>
          <dt>Service</dt>
          <dd>{health.service}</dd>
          <dt>Version</dt>
          <dd>{health.version}</dd>
          <dt>Uptime</dt>
          <dd>{health.uptimeSeconds}s</dd>
        </dl>
      ) : (
        <p style={{ color: 'var(--bad)' }}>
          Could not reach the API at <code>{API_INTERNAL_URL}</code>.
        </p>
      )}
    </main>
  );
}
