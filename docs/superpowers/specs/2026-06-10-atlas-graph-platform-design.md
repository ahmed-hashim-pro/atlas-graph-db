# Atlas — Graph Database Platform: Design Spec

- **Date:** 2026-06-10
- **Status:** Approved design, pending implementation plan
- **Working name:** Atlas (package scope `@atlas/*`; npm publishing is a non-goal for v1)

## 1. Vision

Build a production-ready graph database platform in TypeScript, consisting of:

1. **A graph database engine** built from scratch — property graph model, durable storage (WAL + snapshots), indexes, transactions, a fluent traversal API, a Cypher-like query language (AQL), and a graph algorithms library.
2. **A Knowledge Graph Explorer** — a polished Angular web application for exploring, querying, editing, and analyzing graphs stored in the engine.

The engine is general-purpose by design: future apps (social network analyzer, fraud detector, dependency analyzer) will be built on the same platform as siblings of the explorer. Those apps are explicitly **out of scope for v1**.

"Production-ready" means: self-hosted multi-user deployment with auth and roles, crash-safe durability with a tested recovery path, query safety rails (timeouts, limits, rate limiting), observability (structured logs, metrics, health checks), a full automated test suite gated by CI, Docker single-container deployment, and complete documentation.

## 2. Goals and non-goals

### Goals (v1)

- Durable, crash-safe embedded graph engine with benchmark-verified targets at the **v1 capacity point: 1M nodes / 5M edges within an 8 GB Node heap**. Targets: 2-hop traversal over a 10k-node neighborhood p95 < 50 ms; sustained ≥ 5k write ops/s (group commit, §4.3); full recovery (snapshot load + WAL replay + index rebuild) < 30 s. Larger graphs need compact typed-array layouts — deliberately deferred (§13).
- AQL query language covering read, write, and algorithm invocation, usable from an interactive console.
- Multi-user server: accounts, sessions, API tokens, per-database roles, multiple named databases.
- Live change subscriptions over WebSocket.
- Knowledge Graph Explorer app with graph canvas, query console, schema view, algorithms view, import/export, and admin screens, in three switchable themes.
- Curated seed datasets, Docker deployment, CI, documentation.

### Non-goals (v1)

- Clustering, replication, or horizontal scaling (single-node only).
- Datasets larger than RAM (the graph lives in memory; durability is on disk).
- MVCC / concurrent multi-writer transactions (single-writer queue; see §4.4).
- The social, fraud, and dependency apps (future; the engine's algorithm set anticipates them).
- Versioned/temporal graph snapshots (future need for the dependency analyzer).
- npm publishing, plugin systems, stored procedures.

## 3. Architecture

Monorepo managed with **pnpm workspaces + TypeScript project references**. Node.js ≥ 22. Strict dependency direction — each layer may only import from layers below it:

```
apps/web          Angular 20+ Knowledge Graph Explorer (SPA)
   │  (HTTP + WebSocket via @atlas/client)
packages/client   Typed TS SDK: connect, query, subscribe
   │
packages/protocol Shared zod schemas + wire types (consumed by client AND server)
   │
packages/server   Fastify REST + WS API, auth, multi-DB manager, static hosting
   │
packages/query    AQL: lexer → parser → AST → planner → execution on fluent API
   │
packages/core     Engine: graph store, WAL + snapshots, indexes, transactions,
                  traversals, algorithms, change feed
packages/datasets Curated seed graphs (depends only on core types)
```

Tooling: ESLint + Prettier, Vitest (unit/integration), Playwright (e2e), GitHub Actions CI (typecheck, lint, test, build on every push). Single multi-stage Dockerfile producing one container that runs the server with the built SPA bundled.

## 4. Engine core (`packages/core`)

### 4.1 Data model

- **Node:** engine-assigned id, one or more string labels, property map.
- **Edge:** engine-assigned id, exactly one string type, directed (from → to), property map. Parallel edges and self-loops are allowed.
- **Property values:** `string | number (f64) | boolean | datetime (epoch ms, tagged) | arrays of one primitive type`. **No nested objects/maps in v1.** Property names are strings; values are validated on write.
- **IDs:** positive integers, monotonic per database, never reused, assigned by the engine. Safe as JSON numbers (< 2^53).

### 4.2 In-memory layout

- `nodes: Map<id, NodeRecord>`, `edges: Map<id, EdgeRecord>`.
- Adjacency per node, bucketed by edge type and direction: `out: Map<type, Set<edgeId>>`, `in: Map<type, Set<edgeId>>` — O(1) typed neighbor access both ways.
- Label registry interning label/type strings to small ints to reduce memory pressure.

### 4.3 Durability

- **WAL:** append-only file of binary-framed records: `[u32 length][u32 crc32][payload]`, payload = MessagePack-encoded committed op batch. `fsync` on commit by default with **group commit**: batches that arrive while an fsync is in flight are appended together and acknowledged by the next fsync, so write throughput scales past per-commit disk latency. Configurable mode `always | interval(ms)` (documented trade-off).
- **Snapshots:** background job serializes the full graph (MessagePack) to a new snapshot file with a manifest, then truncates the WAL. Triggered when WAL exceeds a threshold (default 64 MB) or on explicit request. Mechanism: snapshotting briefly **pauses the write queue while encoding the graph to an in-memory buffer** (budget: < 3 s at the v1 capacity point, benchmark-enforced), then resumes writes and flushes the buffer to disk asynchronously. Reads are never blocked. (A zero-pause copy-on-write view is explicitly out of scope for v1 — JS offers no cheap fork-style COW.)
- **Recovery:** load latest valid snapshot, replay WAL tail. A torn/corrupt tail record (CRC mismatch) truncates the WAL at the last valid record with a logged warning. Indexes are rebuilt from data after replay. Recovery reports exactly what was replayed; total recovery time is part of the benchmark-enforced < 30 s budget (§2).
- **Backup:** export endpoint (§6.4) for logical backups; file-level backup documented as snapshot-trigger + copy of the data directory.

### 4.4 Transactions

- API: `db.transact(tx => { tx.createNode(...); tx.createEdge(...); ... })` — atomic all-or-nothing batches.
- Single-writer: all write batches serialize through one queue. Staged ops apply to committed state only at commit, after validation (constraint checks) and WAL append. Rollback = discard staged ops.
- Readers always see fully committed state; no torn reads. Long reads and algorithms take a **read lease**: the write queue holds (incoming batches buffer, nothing applies) until the lease releases — bounded as specified in §4.7.

### 4.5 Indexes and constraints

- **Exact index** (hash) on (label, property) — powers equality lookups and AQL planner starting points.
- **Range index** (in-memory B+-tree) on (label, property) — powers `< > <= >=` and `ORDER BY` on indexed properties.
- **Full-text index** (inverted, lowercase unicode word tokenizer, prefix support) on configured (label, string property) pairs — powers `CONTAINS` and search-as-you-type in the explorer; falls back to scan when absent.
- **Unique constraints** per (label, property), enforced at commit.
- Indexes and constraints are created/dropped via AQL DDL (§5.2) or the embedded API; creating an index over existing data builds it synchronously within a write batch.
- Indexes are rebuilt from data on recovery (not persisted separately in v1; covered by the §2 recovery budget).

### 4.6 Schema introspection

The engine maintains observed-schema statistics continuously: labels with counts, property names/types/frequencies per label, edge types with from/to label distributions. Exposed via API; powers the explorer's Schema view and AQL autocomplete.

### 4.7 Algorithms

Consistency mechanism (normative): algorithms — and any read pipeline that spans event-loop yields (`stream()`, long AQL queries) — run under a **read lease**. The write queue holds for the duration, giving a point-in-time consistent view at zero copy cost. Algorithms use **cooperative yielding** (yield to the event loop every N operations) so the process stays responsive while the lease is held. The lease is bounded by the algorithm time budget (default 30 s, configurable); on expiry the computation aborts with `TIMEOUT` and buffered writes proceed. Lease wait time is exported as a metric (§6.5). Short non-yielding reads run directly on committed state with no lease.

v1 set: BFS/DFS, Dijkstra and A* shortest paths, all-shortest-paths between two nodes, PageRank, weakly/strongly connected components, Louvain community detection, degree centrality, betweenness centrality (Brandes — exact below a configurable node-count guard, k-source sampled approximation above it), topological sort, cycle detection.

### 4.8 Change feed

Every commit emits `{ txId, ops: ChangeOp[] }` into a bounded ring buffer with subscription cursors. Server-side WebSocket subscriptions and any embedded consumer attach here. Overflow policy: a slow consumer receives a final `{ type: 'resync_required' }` event, then its subscription is closed; `@atlas/client` reacts by re-fetching current state and resubscribing from a fresh cursor automatically (surfaced to the app as one `resync` callback).

## 5. Query layer (`packages/query`)

### 5.1 Fluent API (lives in core, specified here for contrast)

Lazy chainable traversals compiled to iterator pipelines; nothing executes before a terminal op.

```ts
g.nodes('Person').where(p => p.born > 1800)
 .out('WROTE').dedup().limit(50).toArray()
```

Steps: `nodes(label?)`, `where(pred)`, `out/in/both(type?)`, `outE/inE(type?)`, `dedup()`, `limit/skip(n)`, `path()`, `order(by)`, aggregations. Terminals: `toArray()`, `first()`, `count()`, `stream()` (async iterator).

### 5.2 AQL — Atlas Query Language

Cypher-like text language. v1 clause surface:

- `MATCH` — node/edge patterns, multi-hop, variable-length paths `-[:TYPE*1..3]->`, multiple comma-separated patterns.
- `WHERE` — comparisons, boolean ops, `CONTAINS` / `STARTS WITH` / `IN`, `EXISTS(prop)`.
- `RETURN` — projections, `AS` aliases, `DISTINCT`, aggregations `count, collect, sum, avg, min, max`.
- `ORDER BY … ASC|DESC`, `SKIP`, `LIMIT`.
- Writes: `CREATE`, `MERGE`, `SET`, `REMOVE`, `DELETE` / `DETACH DELETE`.
- **MERGE semantics (normative):** Cypher-compatible. The **whole pattern** is matched atomically; if no complete match exists, the entire pattern is created — never partial reuse of some elements plus creation of others. `ON CREATE SET` / `ON MATCH SET` are **in v1 scope**. After a preceding `MATCH`, `MERGE` executes once per incoming binding row. A `MERGE` whose creation path would violate a unique constraint raises `CONSTRAINT_VIOLATION`.
- **Schema DDL:** `CREATE INDEX ON :Label(prop)`, `CREATE FULLTEXT INDEX ON :Label(prop)`, `CREATE UNIQUE CONSTRAINT ON :Label(prop)`, matching `DROP …`, plus `SHOW INDEXES` / `SHOW CONSTRAINTS`. DDL flows through the normal query endpoint; owner-only (§6.2).
- `CALL algo.<name>(args) YIELD …` — full algorithm set (§4.7) callable from queries. Pinned v1 signatures:

  | Call | Key params (defaults) | YIELD |
  |---|---|---|
  | `algo.shortestPath` | from, to, type?, weightProp? | path, cost |
  | `algo.allShortestPaths` | from, to, type? | path, cost |
  | `algo.pagerank` | damping=0.85, iterations=20 | node, score |
  | `algo.louvain` | maxLevels=10 | node, community |
  | `algo.components` | mode='weak'\|'strong' | node, component |
  | `algo.degree` | direction='both' | node, score |
  | `algo.betweenness` | sampleK? (auto when above guard) | node, score |
  | `algo.bfs` / `algo.dfs` | from, type?, maxDepth? | node, depth |
  | `algo.topoSort` | type? | node, order |
  | `algo.cycles` | type? | cycle (path) |
- `$parameters` for all literals supplied by applications — injection-safe by construction.
- `EXPLAIN <query>` returns the logical plan as structured JSON (rendered visually in the explorer).

### 5.3 Pipeline

Hand-written lexer → recursive-descent parser → typed AST → planner (selects index-backed starting points by estimated selectivity, orders pattern expansion) → executor compiled onto the fluent API. The whole pipeline is a pure function from `(text, params)` to a plan, fully unit-testable without I/O.

### 5.4 Errors

Every parse and runtime error carries `{ code, message, line, column, snippet }` with a caret marker. Runtime enforcement: per-query timeout and max-rows/max-memory guards, enforced at iterator boundaries.

## 6. Server (`packages/server`) and client SDK (`packages/client`)

### 6.1 Framework and conventions

Fastify on Node 22+. All request/response bodies validated with zod schemas from `packages/protocol` — the shared wire-type package consumed by both server and client SDK, keeping the client fully isomorphic with zero server imports. Errors use RFC 7807 problem-details JSON carrying the `AtlasError` code (§9).

### 6.2 Auth and authorization

- Accounts: username + argon2id-hashed password. First-run bootstrap admin from env (`ATLAS_ADMIN_USER/PASSWORD`).
- Web sessions: httpOnly, SameSite=Lax cookies. Programmatic access: bearer API tokens, hashed at rest, scoped to a user.
- Per-database roles: **owner**, **editor**, **viewer**; plus global **server admins**. Policies (normative): any authenticated user may create a database and automatically becomes its owner; a database may have multiple owners; only owners grant/revoke roles (including owner). Server admins manage users, tokens, and database lifecycle but **cannot read or write database contents** unless explicitly granted a role on that database — enforced and covered by integration tests.

  Permission matrix (v1, normative — `—` means 403 `FORBIDDEN`):

  | Capability | Viewer | Editor | Owner | Server admin |
  |---|---|---|---|---|
  | Read queries · `CALL algo.*` · schema view · export | ✓ | ✓ | ✓ | — |
  | Write queries · node/edge CRUD | — | ✓ | ✓ | — |
  | Import · seed datasets | — | ✓ | ✓ | — |
  | Index & constraint DDL | — | — | ✓ | — |
  | Grant/revoke roles · db settings | — | — | ✓ | — |
  | Delete database | — | — | ✓ | ✓ |
  | View per-db audit log | — | — | ✓ | ✓ |
  | Create databases (creator → owner) | every authenticated user | | | |
  | Manage users & all tokens · global audit | — | — | — | ✓ |

### 6.3 Database manager

Each named database = one engine instance with its own data directory, lazy-loaded on first access, cleanly flushed on shutdown (SIGTERM drains the write queue, fsyncs, snapshots if dirty). The **system catalog** (users, tokens, databases, roles, audit log) is itself an Atlas graph database — the platform runs on its own engine.

### 6.4 Endpoints (REST under `/api`, WS under `/ws`)

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/register`, `/auth/login`, `/auth/logout`, token CRUD |
| Databases | `GET/POST /db`, `GET/PATCH/DELETE /db/:name`, role grants |
| Query | `POST /db/:name/query` — AQL + params; returns rows + graph-shaped results |
| Data | node/edge CRUD `GET/POST/PATCH/DELETE /db/:name/nodes|edges/:id` |
| Schema | `GET /db/:name/schema` |
| Import/export | `POST /db/:name/import` (JSON/CSV), `GET /db/:name/export`, `POST /db/:name/seed/:dataset` |
| Live | `WS /ws/db/:name` — change-feed subscription with label/type filters |
| Ops | `GET /healthz`, `GET /metrics` (Prometheus) |

Import format (normative): JSON `{ nodes: [{ tempId, labels, properties }], edges: [{ from, to, type, properties }] }` where `from`/`to` reference `tempId`s or existing engine ids; the response returns the `tempId → assigned id` mapping. CSV: `nodes.csv` / `edges.csv` with typed header conventions (`name:string`, `born:number`), documented in the API reference. Atomicity: imports apply in batched transactions (10k ops per batch); on failure the import stops, reports what was committed plus the first error with row numbers — an `atomic=true` flag forces all-or-nothing for imports that fit in one batch window. Export emits the same JSON format (full fidelity, real ids).

### 6.5 Safety rails and observability

Per-token rate limiting, query timeout + row/memory caps (env-configurable), CORS allowlist, standard security headers, audit log of write operations (who/when/what). Structured pino logs; metrics: query latency histograms, per-db node/edge counts, WAL size, snapshot timings, WS subscriber counts.

### 6.6 Client SDK

```ts
const atlas = await connect(url, { token });
const db = atlas.database('knowledge-base');
const res = await db.query('MATCH (n:Person) RETURN n LIMIT 10', {});
const sub = db.subscribe({ labels: ['Person'] }, onChange);
```

Thin, fully typed, isomorphic (browser + Node), zero UI dependencies.

## 7. Knowledge Graph Explorer (`apps/web`)

### 7.1 Stack

Angular 20+ (standalone components, signals, zoneless change detection), Angular Router, CodeMirror 6 for the AQL editor, custom Canvas2D graph renderer with d3-force layout. State: signal-based stores per feature; server communication exclusively through `@atlas/client`.

### 7.2 Screens

- **Login / register.**
- **Database picker** — list/create databases, seed from curated datasets, import files.
- **Workspace** (the hero): top bar (database switcher, ⌘K node search, live indicator, theme switcher, user menu); left rail (view navigation; label/edge-type legend with visibility toggles and counts); center graph canvas; right inspector (selected node/edge properties — editable, connection list, expand/paths actions); bottom dock AQL console (editor with highlighting + schema-aware autocomplete + error squiggles; tabs: Results table, visual EXPLAIN Plan, History; results can also be projected onto the canvas).
- **Schema view** — auto-generated diagram of labels and edge types from introspection (§4.6).
- **Algorithms view** — parameter forms for the algorithm set; results painted onto the canvas (node size = score, color = community, highlighted paths).
- **Admin** — users, tokens, roles, audit log, database settings.

### 7.3 Graph canvas

Custom renderer, plain-TypeScript core (framework-agnostic) wrapped in an Angular component. d3-force simulation runs in a **Web Worker**; positions stream to the main thread; Canvas2D draws (no per-node DOM). Interactions: zoom/pan, click select, double-click expand neighbors (capped + paged), right-click context menu, drag to pin. Degrades gracefully to a configurable max rendered nodes with a "showing N of M" indicator and filter prompts.

### 7.4 Theming

Three first-class themes as CSS custom-property token sets: **Midnight Observatory** (default — dark, glowing nodes, violet/cyan), **Clean Laboratory** (light, crisp), **Neon Terminal** (monospace, neon green). Instant switching, persisted per user. Canvas renderer reads colors from the active token set.

### 7.5 Accessibility

Keyboard navigation for all non-canvas UI, visible focus states, WCAG AA contrast in all three themes, ARIA labeling on controls; canvas interactions mirrored by an accessible node list/table view of current results.

## 8. Datasets (`packages/datasets`)

Two curated seed graphs shipped as JSON with loader helpers: **science-history** (~500 nodes: people, concepts, documents, places; WROTE/KNOWS/CITES/INFLUENCED/BORN_IN) and **movies** (~1.2k nodes: films, people, genres; ACTED_IN/DIRECTED/IN_GENRE). Also ships a **deterministic synthetic graph generator** (seeded RNG; configurable node/edge counts and degree distribution) that produces the capacity-point graphs used by the benchmark suite. Used by demos, docs, e2e tests, and benchmarks.

## 9. Error handling

One `AtlasError` hierarchy with stable string codes (`PARSE_ERROR`, `CONSTRAINT_VIOLATION`, `TIMEOUT`, `UNAUTHORIZED`, `FORBIDDEN`, `WAL_CORRUPT_TAIL`, `RESYNC_REQUIRED`, …; note: no `TX_CONFLICT` — the single-writer model cannot produce write conflicts) flowing engine → server (problem-details) → SDK (typed exceptions) → UI (console annotations, toasts). No silent failures: every catch either rethrows a typed error or logs at warn+ with context. Recovery and compaction log precise, actionable summaries.

## 10. Testing strategy

- **core:** Vitest unit tests; property-based tests (fast-check) for storage invariants; a **crash-recovery suite** that kills a child process mid-write and asserts clean recovery; algorithm correctness against known small graphs; benchmark suite asserting §2 capacity/latency/recovery targets on synthetic capacity-point graphs from the datasets generator — running in CI's nightly lane from M1 onward, not deferred to the end.
- **query:** lexer/parser golden tests; execution tests over seed datasets; planner tests (index selection); error-position tests.
- **server:** API integration tests against a temp data dir (auth, roles, limits, import/export, WS subscriptions).
- **web:** component tests for stores and critical components; Playwright e2e covering login → create db → seed → explore → query → algorithm overlay.
- CI runs everything on every push; merge gated on green.

## 11. Deployment and configuration

Single Docker image (multi-stage build): Node server serving API + built SPA. Volume-mounted data directory. Configuration via env: `ATLAS_DATA_DIR`, `ATLAS_PORT`, `ATLAS_SECRET` (session signing), `ATLAS_ADMIN_USER/PASSWORD` (bootstrap), fsync mode, query/rate limits. `docker compose up` works out of the box; README documents backup/restore and upgrade (WAL/snapshot format carries a version header; v1 promises forward-compatible reads within major version).

## 12. Build order (milestones)

1. **M0 Scaffold** — monorepo, tooling, CI, Docker skeleton.
2. **M1 Engine storage** — graph store, transactions, WAL (group commit), snapshots, recovery + crash suite; synthetic graph generator + benchmark harness (capacity targets tracked from here on).
3. **M2 Indexes + fluent API** — exact/range/full-text indexes, constraints, traversals, read leases, schema introspection, change feed; science-history dataset + loaders.
4. **M3 Algorithms** — full v1 set with yielding, leases, budgets.
5. **M4 AQL** — lexer → parser → planner → executor, DDL, EXPLAIN, errors; movies dataset; AQL reference doc.
6. **M5 Server + SDK** — protocol package, auth + permission matrix, db manager, system catalog, endpoints, WS, limits, metrics.
7. **M6 Explorer** — Angular app in testable slices, in order: shell + auth + database picker → workspace canvas → AQL console → schema + algorithms views → admin + theming polish; Playwright e2e lands per slice.
8. **M7 Production hardening** — benchmark sign-off vs §2 targets, docs, seed polish, release v1.

Each milestone lands with its tests, and each gets **its own implementation plan** — the spec decomposes into per-milestone plans rather than one monolithic plan. The app is built last against a fully working platform.

## 13. Risks and mitigations

- **JS performance ceiling** (per-object memory overhead, GC pressure): the v1 capacity point (1M nodes / 5M edges) is chosen to fit comfortably in an 8 GB heap with Map/Set layouts; interned labels and numeric ids keep overhead down; the benchmark suite tracks memory from M1. Tens of millions of elements would require typed-array/CSR layouts — deliberately deferred; the storage interface keeps that door open.
- **Single-writer throughput**: group commit (§4.3) lifts the fsync ceiling; acceptable for the target use (interactive + moderate ingestion); import endpoint batches writes; documented limitation.
- **Read-lease write stalls**: a long algorithm pauses writes for up to its time budget (default 30 s); bounded by config, surfaced via the lease-wait metric, acceptable for interactive v1 workloads.
- **Scope creep** (it's a database *and* an app): milestones are strictly ordered; future apps explicitly out of scope.
- **WAL corruption edge cases**: CRC framing, torn-tail truncation, crash-recovery suite in CI from M1.
- **Canvas performance on large result sets**: worker-based physics, render caps with paging, benchmark with 10k-node renders.

## 14. Resolved decisions log

TypeScript end-to-end · embedded lib + server (not server-only, not on-disk pages) · fluent API + AQL (not either alone) · self-hosted multi-user (not single-user, not SaaS) · layered monorepo engine-first (not app-first, not split repos) · Angular for the web app (user decision, replacing the initial React proposal) · all three visual themes ship, Midnight Observatory default · curated datasets are generated deterministically in code (curated core + seeded expansion), not shipped as static JSON files as §8 originally phrased it (M2 decision; loaders unchanged).
