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

## Current status

**Phase 0 — scaffold.** Both services build and run, the web app reads the API's
health endpoint, and Postgres is up but not yet used. Phase 1 adds the schema.

The full roadmap is in [docs/design.md](docs/design.md#7-roadmap).
