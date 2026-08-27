# url-generator

A URL shortener, built phase by phase from a system design reference for a
link-shortening service.

The design is documented as it is built:

- **[docs/design.md](docs/design.md)** — the system as it stands, and where it's going
- **[docs/adr/](docs/adr)** — why each decision was made

## Stack

| | |
| --- | --- |
| Web | Next.js 16 (App Router), React 19 |
| API | Fastify 5 |
| Database | Postgres 18 + Drizzle ORM |
| Cache | Redis 8 (read path, cache-aside) |
| Language | TypeScript 7, strict, everywhere |
| Runtime | Node 22 |
| Orchestration | Docker Compose |

Structured as an npm workspace:

```
apps/api        Fastify API — shorten, redirect, analytics
apps/api/drizzle  Generated SQL migrations, applied by the migrate service
apps/web        Next.js UI
packages/shared Types shared across the wire
docs/           Design document and decision records
```

## Running it

Requires Docker.

```bash
cp .env.example .env
docker compose up --build
```

| Service | URL |
| --- | --- |
| Web | http://localhost:3000 |
| API | http://localhost:4000/health |
| Postgres | `localhost:5432` |
| Redis | `localhost:6379` |

`docker compose up` runs a one-shot `migrate` service first; the API waits for
it to exit successfully, so the schema is always current before anything queries
it ([ADR 0006](docs/adr/0006-migrations-as-a-one-shot-job.md)).

Source is bind-mounted, so both services hot-reload on save.

To stop, and to drop the database volume with it:

```bash
docker compose down -v
```

Redis has no volume by design — it is a cache, and every key in it is
reconstructible from Postgres ([ADR 0009](docs/adr/0009-redis-cache-aside-on-the-read-path.md)).

When a phase adds a dependency, recreate the containers rather than restarting
them: the `node_modules` volume is anonymous and Compose reuses it across a
recreate, so the image's fresh `npm ci` stays masked until the container is
replaced.

```bash
docker compose down && docker compose up --build -d
```

## Working outside Docker

Useful for type checking and quick iteration:

```bash
npm install
npm run typecheck
```

`REDIS_URL` is optional — leave it unset and the API runs without a cache,
which is correct, just slower. `/health` reports the cache as `disabled` rather
than `unreachable` in that case.

## Changing the schema

Edit `apps/api/src/db/schema.ts`, then generate the SQL:

```bash
npm run db:generate --workspace @url-generator/api
```

Rename the generated file to describe what it does and update the matching
`tag` in `apps/api/drizzle/meta/_journal.json`, then review the SQL and commit
it. It is applied on the next `docker compose up`, or immediately with:

```bash
docker compose run --rm migrate
```

To browse the data:

```bash
docker compose exec postgres psql -U urlshortener -d urlshortener
```

## Current status

**Phase 4 — Redis on the read path.** `GET /{code}` now resolves from a
cache-aside lookup: Redis first, Postgres on a miss, and the result written
back ([ADR 0009](docs/adr/0009-redis-cache-aside-on-the-read-path.md)).

```bash
curl -s localhost:4000/health | jq .dependencies.cache
```

```json
{ "status": "ok", "latencyMs": 1 }
```

**The cache is never a dependency.** Unreachable, slow, or empty all reach the
read path as a miss — which is exactly Phase 3's behaviour. Stopping Redis
outright leaves redirects answering in ~3 ms, writes working, and `/health`
reporting `degraded` while still returning 200; the API reconnects on its own.
That is the point of the phase: N1 asks for 99.99% on the redirect path, and a
cache that can take that path down with it would be a net loss no matter how
many round-trips it saved.

| | p50 | p99 |
| --- | --- | --- |
| Postgres lookup (Phase 3) | 0.156 ms | 0.588 ms |
| Redis lookup | 0.052 ms | 0.086 ms |
| `GET /{code}` end to end | 2.38 ms | 5.56 ms |

Which is the honest reading: at this scale the cache is not what makes the
redirect fast — it already was, and the 50 ms budget is spent on HTTP, not on
the lookup. What changes is the slope. Every hit is a query Postgres does not
run, so read capacity stops being bounded by one database's connection pool.

**Misses are cached too**, for 30 seconds. `/{code}` is the catch-all under the
origin, so without a negative entry a scanner walking seven-character strings
costs one Postgres round-trip per guess. The write path deletes the entry when
it creates a code, and the short TTL bounds the cases where that delete cannot
help.

Expiry and the destination check stay in the application, above the cache, so
a link expires on schedule even when its entry has 59 minutes of TTL left, and
a planted `javascript:` destination is refused on the cached path exactly as on
the uncached one.

The full roadmap is in [docs/design.md](docs/design.md#7-roadmap); Phase 5 adds
custom aliases.
