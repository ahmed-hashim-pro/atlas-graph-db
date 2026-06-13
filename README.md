# Atlas

A graph database platform in TypeScript: a from-scratch embedded engine
(WAL + snapshots, transactions, indexes, traversals, algorithms, AQL query
language) with a multi-user server and the Knowledge Graph Explorer web app.

**Status:** M5a — server foundation (`@atlas/server` on Fastify): argon2id auth
(sessions + API tokens), multi-database manager with the system catalog stored
as an Atlas database, and REST for auth, database lifecycle, role grants, query,
and schema — with the spec's permission matrix enforced. WS subscriptions, CRUD,
import/export, the client SDK, and metrics land in M5b.
Design spec: `docs/superpowers/specs/2026-06-10-atlas-graph-platform-design.md`.

## Develop

```bash
pnpm install
pnpm build && pnpm lint && pnpm test
```

## Benchmark

```bash
SCALE=0.05 node --expose-gc --import tsx packages/core/bench/storage.bench.ts
```
