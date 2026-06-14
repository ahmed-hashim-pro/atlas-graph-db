# Atlas

A graph database platform in TypeScript: a from-scratch embedded engine
(WAL + snapshots, transactions, indexes, traversals, algorithms, AQL query
language) with a multi-user server and the Knowledge Graph Explorer web app.

**Status:** M6c — Knowledge Graph Explorer: AQL console, schema view, and
algorithms view. The bottom-dock console is a CodeMirror 6 editor with AQL
syntax highlighting, schema-aware autocomplete, and ⌘/Ctrl+Enter to run; it
shows a Results table, a visual EXPLAIN Plan tree, and a localStorage-persisted
History tab, surfaces AqlError as a caret-positioned message, and can project
node-bearing results onto the canvas. The Schema view auto-generates a diagram
of labels (with counts) and edge types from `Database.schema()` introspection.
The Algorithms view offers parameter forms for the v1 algorithm set
(PageRank/Louvain/components/degree/betweenness/shortest paths/BFS/DFS/topoSort/
cycles), runs them via `CALL algo.*`, and paints results onto the canvas (node
size = score, color = community, highlighted paths). Parsing/tokenizing/
completion/plan-transform/history/schema-layout are plain-TS Vitest modules;
Angular + CodeMirror are thin wrappers. The canvas itself is M6b; admin + import
UI + final polish are M6d.
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
