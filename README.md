# Atlas

A graph database platform in TypeScript: a from-scratch embedded engine
(WAL + snapshots, transactions, indexes, traversals, algorithms, AQL query
language) with a multi-user server and the Knowledge Graph Explorer web app.

**Status:** M4 complete — full AQL (`@atlas/query`): reads (MATCH/WHERE/RETURN,
aggregations, variable-length paths), writes (CREATE/MERGE/SET/REMOVE/DELETE),
schema DDL, and `CALL algo.*`, all atomic and EXPLAIN-able. See
`docs/aql-reference.md`.
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
