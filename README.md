# Atlas

A graph database platform in TypeScript: a from-scratch embedded engine
(WAL + snapshots, transactions, indexes, traversals, algorithms, AQL query
language) with a multi-user server and the Knowledge Graph Explorer web app.

**Status:** M6 complete — the Knowledge Graph Explorer (`apps/web`, Angular 20
standalone + signals + zoneless) is feature-complete. On top of the M6a–M6c
shell, themes, auth, database picker, graph canvas, AQL console, schema view, and
algorithms view, M6d adds: data import (paste/upload JSON `{nodes,edges}` and CSV,
atomic toggle, committed/idMap/first-error result); a ⌘K command palette that
searches nodes by name via AQL and selects + centers the chosen node on the
canvas; and Admin views for API token management (create-once / list / revoke)
and per-database role grants (grant/revoke viewer/editor/owner on databases you
own, owners surfaced from the db info). Login/register now route through
AuthService and the session rehydrates on a hard refresh. Deferred to M7
(production hardening): global user management and audit-log UI (no server
endpoints yet), inline AQL error squiggles, and editable db settings UI.
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
