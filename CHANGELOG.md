# Changelog

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
