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
apps/api/src/expiry  The cleanup sweep, run as its own service
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

**Phase 6 — expiration.** `POST /shorten` takes an optional `expiresIn` in
seconds, and a periodic sweep deletes links that ran out long enough ago
([ADR 0011](docs/adr/0011-link-expiry-with-a-retention-window.md)).

```bash
curl -s -X POST localhost:4000/shorten \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/launch","expiresIn":3600}'
```

```json
{
  "shortCode": "P8pGiSu",
  "shortUrl": "http://localhost:4000/P8pGiSu",
  "longUrl": "https://example.com/launch",
  "createdAt": "2026-08-27T23:35:26.513Z",
  "expiresAt": "2026-08-28T00:35:26.513Z",
  "created": true,
  "isCustom": false
}
```

**The request is a duration; the response is an instant.** A TTL is naturally a
duration, and the conversion happens once, on the clock that will later judge
it — an absolute timestamp measured on a caller's clock and re-judged on ours is
a link that arrives already expired because a laptop runs four minutes fast.

| `expiresIn` | Meaning |
| --- | --- |
| a number | This link lives that many seconds |
| `null` | Never expires — declining the deployment's default |
| omitted | No opinion; `DEFAULT_LINK_TTL_SECONDS` applies, if it is set |
| `0`, `-5`, or over `MAX_LINK_TTL_SECONDS` | `400 invalid_ttl` |
| `"3600"`, `1.5` | `400 invalid_request` |

Both knobs are unset out of the box, which is every earlier phase's behaviour:
links are permanent unless asked otherwise. They are different kinds of thing —
`DEFAULT_LINK_TTL_SECONDS` is a convenience a caller may decline with `null`,
and `MAX_LINK_TTL_SECONDS` is a policy they may not, so under a ceiling `null`
is rejected like any other over-long request.

**The read path did not change.** It has refused expired links since Phase 3,
on a cached copy exactly as on a row, so this phase landed on the write path and
in a cleanup job. A link expires on schedule even when its cache entry has 59
minutes left — proven by the log line, where the 410 is served from a cache
entry written while the link was still alive:

```
{"shortCode":"5tl1SYx","source":"cache","outcome":"expired","msg":"resolved short code"}
```

**An expired row is a tombstone, not a deletion.** It is kept for
`EXPIRY_RETENTION_SECONDS` — a week by default — so `GET /{code}` can answer
`410 gone` rather than `404`; a crawler that gets 410 drops the URL, one that
gets 404 keeps retrying. The sweep deletes it afterwards, and the same code
answers 404 from then on.

That makes "the code is taken" three situations rather than two, and the write
path has to tell them apart:

| Request | Answer |
| --- | --- |
| Same URL again, any `expiresIn` | `200` with the stored `expiresAt` — a live link is never renewed by re-submission |
| Same URL after it expired | `201`, the same code, re-created in place |
| Same alias, same destination, expired | `201` — a renewal |
| Same alias, different destination, expired | `409 alias_taken` until the sweep |

A live mapping is never modified. The guard is the `where` clause on the revive
— still expired, still pointing at the same destination, evaluated by Postgres
at the instant it runs — rather than the check that precedes it, so no
interleaving of requests can turn it into an overwrite.

**The sweep is storage hygiene, not enforcement.** Nothing about expiry depends
on it running, which is what makes it safe to batch, to run late, and to fail.
It runs as its own service rather than a timer inside the API: the API's
connection pool belongs to the read path, one sweeper is enough however many API
replicas there are, and a background job you can stop without stopping the API
is one you can stop during an incident.

```bash
docker compose logs sweep
```

To sweep immediately — after inserting test data, or when a takedown needs the
tombstone gone now:

```bash
docker compose run --rm sweep npm run db:sweep:once --workspace @url-generator/api
```

The full roadmap is in [docs/design.md](docs/design.md#7-roadmap); Phase 7 adds
click analytics.
