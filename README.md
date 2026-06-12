# Atlas

A graph database platform in TypeScript: a from-scratch embedded engine
(WAL + snapshots, transactions, indexes, traversals, algorithms, AQL query
language) with a multi-user server and the Knowledge Graph Explorer web app.

**Status:** M4a — AQL read pipeline (`@atlas/query`): lexer → parser →
selectivity-based planner (EXPLAIN as JSON) → guarded executor. MATCH with
variable-length hops, WHERE, RETURN aggregations, ORDER BY/SKIP/LIMIT,
$parameters, caret-annotated errors. Writes/DDL/CALL land in M4b.
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
