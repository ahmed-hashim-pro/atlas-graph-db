# Atlas

A graph database platform in TypeScript: a from-scratch embedded engine
(WAL + snapshots, transactions, indexes, traversals, algorithms, AQL query
language) with a multi-user server and the Knowledge Graph Explorer web app.

**Status:** M6b — Knowledge Graph Explorer workspace (`apps/web`): the `/db/:name`
route is now the real graph workspace — a Canvas2D graph canvas as the hero with a
seeded d3-force layout running in a Web Worker, a framework-agnostic signal-based
graph store (visible node/edge set, selection, label/edge-type visibility toggles
with counts, and a render cap with "showing N of M"), pure viewport zoom/pan +
point→node hit-testing, a theme-reactive renderer (colors from the active token
set), pointer interactions (zoom/pan, click-select, drag-to-pin, double-click
expand-neighbors capped+paged via AQL, right-click context menu), a left
label/edge legend, a right inspector (read-only properties + connection list +
expand/paths actions), and live updates via the change feed. The AQL console,
schema view, and algorithms view land in M6c; admin, import UI, ⌘K search, and
inspector editing land in M6d.
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
