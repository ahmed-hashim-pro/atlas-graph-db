# Atlas

A graph database platform in TypeScript: a from-scratch embedded engine
(WAL + snapshots, transactions, indexes, traversals, algorithms, AQL query
language) with a multi-user server and the Knowledge Graph Explorer web app.

**Status:** M3 — graph algorithms (`db.algo.*`): BFS/DFS, Dijkstra/A\*,
all-shortest-paths, degree, weak/strong components, topoSort, cycles,
PageRank, Louvain, sampled Brandes betweenness — all lease-protected with
cooperative yielding and budgets.
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
