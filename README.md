# Atlas

A graph database platform in TypeScript: a from-scratch embedded engine
(WAL + snapshots, transactions, indexes, traversals, algorithms, AQL query
language) with a multi-user server and the Knowledge Graph Explorer web app.

**Status:** v1.1.0 — production-ready. A from-scratch embedded graph engine
(WAL + snapshots + crash recovery, transactions, property/unique/fulltext
indexes, traversals, graph algorithms, a change feed) under a full AQL query
language, a multi-user Fastify server (argon2id auth with revocable sessions +
API tokens, a permission matrix, a system catalog that dogfoods the engine,
REST + WebSocket, import/export, Prometheus `/metrics`, rate limiting, CORS,
security headers, static SPA hosting), a typed isomorphic client SDK, and the
Knowledge Graph Explorer (Angular 20, standalone + signals + zoneless: graph
canvas, AQL console, schema + algorithms views, data import, ⌘K node search,
token/role admin). Benchmark targets per §2 are tracked in `docs/BENCHMARKS.md`.

## Quickstart (Docker)

```bash
export ATLAS_SECRET=$(openssl rand -base64 32)   # 32+ chars, session signing
export ATLAS_ADMIN_USER=admin
export ATLAS_ADMIN_PASSWORD=change-me-please
docker compose up --build
# Explorer + API on http://localhost:4848  (SPA served from the same origin)
```

The server serves the built SPA and the API from one origin; the data directory
is a mounted volume (`atlas-data` → `/data`). Configuration is via env
(`ATLAS_DATA_DIR`, `ATLAS_PORT`, `ATLAS_SECRET`, `ATLAS_ADMIN_USER/PASSWORD`,
`ATLAS_QUERY_TIMEOUT_MS`, `ATLAS_MAX_ROWS`, `ATLAS_RATE_LIMIT`,
`ATLAS_CORS_ORIGINS`, `ATLAS_SESSION_TTL_MS`, `ATLAS_STATIC_DIR`).

### Backup / restore

The entire database lives under `ATLAS_DATA_DIR` (snapshots + WAL per database,
plus the `_catalog`). Back up by snapshotting the volume while the server is
stopped (or after a checkpoint); restore by replacing the directory. The
WAL/snapshot format carries a version header (forward-compatible reads within a
major version).

## Features

- **Engine:** crash-safe WAL with group commit + background snapshots; recovery
  with torn-tail truncation; property, unique, and fulltext indexes; BFS/DFS,
  shortest paths, PageRank, components, Louvain, betweenness, topo-sort, cycles;
  a label/type-filtered change feed.
- **AQL:** MATCH/WHERE/RETURN, CREATE/MERGE/SET/REMOVE/DELETE, variable-length
  paths, aggregates, `lower()`/`id()`/`labels()`/`type()` scalars, `CALL algo.*`
  with YIELD, EXPLAIN, parameters, timeouts, and row caps.
- **Server:** argon2id auth (revocable server-side sessions + bearer tokens), a
  viewer/editor/owner permission matrix, server-admin user management, a write-op
  audit log, lazy per-database engines, import/export (JSON + CSV), Prometheus
  `/metrics`, rate limiting, CORS, security headers.
- **Explorer:** graph canvas (Web Worker layout, Canvas2D), AQL console with inline
  error squiggles, schema + algorithms views, data import, case-insensitive ⌘K node
  search, editable database settings, user/audit/token/role admin, three themes.

## Architecture (in words)

`@atlas/core` is the embedded engine (storage, WAL, snapshots, indexes,
traversals, algorithms, change feed). `@atlas/query` is the AQL lexer → parser →
planner → executor over the engine. `@atlas/protocol` holds the zod wire schemas
shared by server and client. `@atlas/server` is a Fastify app: a `DatabaseManager`
opens user databases lazily; a `CatalogService` stores users, tokens, sessions,
databases, and role grants as an Atlas database (the platform dogfoods its own
engine); routes enforce the permission matrix and surface RFC 7807 problem-details
carrying engine/AQL codes. `@atlas/client` is the typed isomorphic SDK.
`@atlas/datasets` provides curated + synthetic seed graphs (the latter drives the
benchmarks). `apps/web` is the Angular Explorer, talking to the server only
through `@atlas/client`.

## Reference

- API: [`docs/api-reference.md`](docs/api-reference.md)
- AQL: [`docs/aql-reference.md`](docs/aql-reference.md)
- Benchmarks: [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md)
- Changelog: [`CHANGELOG.md`](CHANGELOG.md)
- Design spec: `docs/superpowers/specs/2026-06-10-atlas-graph-platform-design.md`

## Develop

```bash
pnpm install
pnpm build && pnpm lint && pnpm test
```

## Benchmark

See [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) for capacity targets and sign-off results.

```bash
SCALE=0.05 node --expose-gc --import tsx packages/core/bench/storage.bench.ts
```
