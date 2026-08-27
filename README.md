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

**Phase 5 — custom aliases.** `POST /shorten` takes an optional `customAlias`
and claims it instead of generating a code
([ADR 0010](docs/adr/0010-custom-aliases-in-one-namespace.md)).

```bash
curl -s -X POST localhost:4000/shorten \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/launch","customAlias":"launch-notes"}'
```

```json
{
  "shortCode": "launch-notes",
  "shortUrl": "http://localhost:4000/launch-notes",
  "longUrl": "https://example.com/launch",
  "createdAt": "2026-08-27T22:55:58.153Z",
  "created": true,
  "isCustom": true
}
```

An alias is a short code in every other respect — same column, same primary key,
same namespace, same read path. This phase changed no line of the read path and
needed no migration: `short_code` has been `varchar(32)` and `is_custom` has
existed since Phase 1.

**The retry is the difference.** A generated code that collides is re-hashed,
because the caller asked for *a* link and any free code satisfies that. `mylink`
is the request, so a taken alias is a 409 and there is nothing to retry with.
The claim itself is the same `INSERT ... ON CONFLICT DO NOTHING` the collision
loop uses, which is what makes it race-free: twenty concurrent claims on one
alias with twenty different destinations return one 201 and nineteen 409s, and
leave one row.

| Request | Answer |
| --- | --- |
| Alias is free | `201`, `isCustom: true` |
| Same alias, same destination | `200` — a retried request is not a conflict |
| Same alias, different destination | `409 alias_taken` |
| `health`, `login`, `billing`, … | `400 alias_reserved` — never available, so not a 409 |
| Under 3 chars, over 32, or `my link` | `400 invalid_alias` |

**Reserved words belong to the namespace, not to the endpoint.**
`GET /{code}` is the catch-all under the origin, so an alias can shadow a route:
`GET /shorten` already arrives at the redirect handler as the code `shorten`,
harmlessly, right up until someone can create that code. The check is
case-insensitive — `/Login` is as convincing as `/login` to whoever is deciding
whether to click — and it runs against generated codes too, since `shorten` is
seven Base62 characters like every code the generator emits.

**One URL can now have several codes.** Deduplication was a property of
derivation (ADR 0003) and a chosen code is not derived, so claiming an alias for
a URL that already has a generated mapping creates a second one. Both redirect;
`shortCode` is the identity, and the URL never was.

The full roadmap is in [docs/design.md](docs/design.md#7-roadmap); Phase 6 adds
expiration.
