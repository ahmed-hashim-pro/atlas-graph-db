# Changelog

## 1.1.0 — 2026-06-23

Backlog features on top of v1.0.0; engine on-disk format unchanged (the new
audit log and user store reuse the catalog, dogfooding the engine).

### Server (`@atlas/server`)

- **Global user management** (server-admin only): `GET/POST /api/users`,
  `PATCH /api/users/:username` (admin flag), `POST /api/users/:username/password`
  (reset; revokes that user's sessions), `DELETE /api/users/:username`. Last-admin
  and self-delete lockouts are enforced atomically inside the write queue (no
  TOCTOU race under concurrent admin changes).
- **Audit log of write operations**: `GET /api/audit?limit=` returns recent
  entries (newest first) covering node/edge writes, import/seed, database and role
  changes, write queries, and user admin. Recording is best-effort — an
  audit-store failure never fails the underlying committed write.

### Client (`@atlas/client`)

- SDK methods: `listUsers`, `createUser`, `updateUser`, `resetUserPassword`,
  `deleteUser`, `listAudit`, `patchDatabase`.

### Explorer (`apps/web`)

- Admin: **Users** panel (list/create/promote-demote/reset-password/delete) and
  an **Audit log** viewer.
- Workspace: editable **database-settings** form (description) and an inline
  **AQL error squiggle** in the console (wavy underline over the offending range,
  complementing the existing caret banner).

## 1.0.0 — 2026-06-15

First production release of Atlas: an embedded graph engine, AQL query language,
multi-user server, client SDK, and the Knowledge Graph Explorer.

### Engine (`@atlas/core`)

- Crash-safe WAL (group commit) + background snapshots; recovery with torn-tail
  truncation and index rebuild.
- Property / unique / fulltext indexes; transactions; traversals.
- Algorithms: BFS, DFS, shortest path(s), PageRank, weak/strong components,
  Louvain, betweenness, topological sort, cycle detection.
- Change feed with label/type filtering.

### Query (`@atlas/query`)

- Full AQL: MATCH/WHERE/RETURN, CREATE/MERGE/SET/REMOVE/DELETE, variable-length
  paths, aggregates, EXPLAIN, parameters, timeouts, row caps.
- Scalar functions `id()`, `labels()`, `type()`, and `lower()` (case-insensitive
  matching).
- `CALL algo.*` with YIELD, validated against each algorithm's static schema.

### Server (`@atlas/server`)

- Argon2id auth: revocable server-side sessions (opaque cookie id) + bearer API
  tokens; viewer/editor/owner permission matrix; system catalog dogfooding the
  engine.
- REST + WebSocket; import/export (JSON + CSV); RFC 7807 problem-details carrying
  engine/AQL codes (including `DETACH_REQUIRED` → 409).
- Observability: Prometheus `/metrics` (query count, query errors, latency
  histogram, WS subscribers); rate limiting; CORS; security headers; static SPA
  hosting.

### Client (`@atlas/client`)

- Typed isomorphic SDK (cookie + bearer modes): auth, databases, query, schema,
  subscribe, tokens, roles, import/export.

### Explorer (`apps/web`)

- Angular 20 (standalone, signals, zoneless): graph canvas, AQL console, schema
  and algorithms views, data import, case-insensitive ⌘K node search (focus-
  trapped dialog), token + role admin, three themes.

### Deployment

- Single multi-stage Docker image running compiled output with pruned production
  dependencies; `docker compose up` serves the Explorer + API from one origin.

### Benchmarks

- §2 capacity-point targets (1M nodes / 5M edges in 8 GB heap; 2-hop p95 < 50 ms;
  ≥ 5k write ops/s; recovery < 30 s) tracked in `docs/BENCHMARKS.md`, asserted by
  the release-gate command and the nightly bench lane.
