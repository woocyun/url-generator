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

**Phase 2 — `POST /shorten`.** The write path works end to end: a URL is
canonicalized, hashed with SHA-256, truncated, and Base62-encoded into a
7-character code, then claimed with a single `INSERT ... ON CONFLICT DO NOTHING`
([ADR 0007](docs/adr/0007-sha256-truncated-to-seven-base62-characters.md)).

```bash
curl -X POST localhost:4000/shorten -H 'content-type: application/json' -d '{"url":"https://example.com/some/very/long/path?a=1"}'
```

```json
{
  "shortCode": "wYx0ePz",
  "shortUrl": "http://localhost:4000/wYx0ePz",
  "longUrl": "https://example.com/some/very/long/path?a=1",
  "createdAt": "2026-08-27T01:28:00.220Z",
  "created": true
}
```

Codes are derived from the URL rather than allocated, so shortening the same
destination twice returns the same code and stores one row — the response says
so with `created: false` and a 200 instead of a 201. Two different URLs that
hash to the same code are resolved by re-hashing with the attempt number, up to
five times; exhausting that is a 500, never a silent duplicate.

`GET /{code}` does not exist yet, so the `shortUrl` above is a promise Phase 3
keeps. The full roadmap is in [docs/design.md](docs/design.md#7-roadmap).
