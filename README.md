# Atlas

A graph database platform in TypeScript: a from-scratch embedded engine
(WAL + snapshots, transactions, indexes, traversals, algorithms, AQL query
language) with a multi-user server and the Knowledge Graph Explorer web app.

**Status:** M6a — Knowledge Graph Explorer foundation (`apps/web`, Angular 20
standalone + signals + zoneless): the `@atlas/client` SDK gains a cookie/session
mode so the app talks to the server exclusively through it; three first-class
themes (Midnight Observatory, Clean Laboratory, Neon Terminal) with a persisted
ThemeService; auth (login/register + route guard); and an authenticated shell
with a database picker (list/create/seed/open). The graph workspace canvas,
AQL console, schema view, algorithms view, and admin land in M6b–M6d; the
`/db/:name` route is a placeholder here.
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
