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

`docker compose up` runs a one-shot `migrate` service first; the API waits for
it to exit successfully, so the schema is always current before anything queries
it ([ADR 0006](docs/adr/0006-migrations-as-a-one-shot-job.md)).

Source is bind-mounted, so both services hot-reload on save.

To stop, and to drop the database volume with it:

```bash
docker compose down -v
```

## Working outside Docker

Useful for type checking and quick iteration:

```bash
npm install
npm run typecheck
```

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

**Phase 3 — `GET /{code}`.** The loop closes: a link created by `POST /shorten`
now resolves. The `shortUrl` from Phase 2 is a working link rather than a
promise.

```bash
curl -i localhost:4000/wYx0ePz
```

```
HTTP/1.1 302 Found
location: https://example.com/some/very/long/path?a=1
cache-control: no-store
```

**302, not 301**, and nothing this route returns is cacheable
([ADR 0008](docs/adr/0008-302-redirects-with-no-store-and-410-for-expired-links.md)).
A 301 is faster for a repeat visitor exactly because the browser stops
contacting us — and a link we never see again is one we cannot count, expire, or
take down. The round-trip is what buys the link's lifecycle back, and it is
cheap: a primary-key lookup on two columns, p50 0.53 ms / p99 1.41 ms locally
against the design's 50 ms budget.

An unknown code is a `404`; a code that resolves to a link past its expiry is a
`410`, because a crawler that gets a 410 drops the URL while one that gets a 404
keeps retrying. The expiry branch is live but unreachable through the public API
until Phase 6 starts setting `expires_at` — the read path honours the column
before the write path fills it.

Paths that cannot be short codes (`/favicon.ico`, `/robots.txt`, a scanner
walking a wordlist) are answered from their shape without touching Postgres, so
the hot path's round-trips track real traffic rather than whatever points at the
origin.

The full roadmap is in [docs/design.md](docs/design.md#7-roadmap); Phase 4 puts
a Redis cache in front of this lookup.
