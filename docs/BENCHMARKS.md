# Atlas Benchmarks

Atlas tracks the spec §2 v1 capacity-point targets from M1 onward. Two harnesses
live in `packages/core/bench/`; both build a deterministic synthetic graph
(`@atlas/datasets` `generateGraph`, seed 42) sized by a `SCALE` factor where
`SCALE=1` is the capacity point (**1,000,000 nodes / 5,000,000 edges**).

## §2 targets (capacity point, SCALE=1)

| Target | Budget |
|---|---|
| Heap (resident graph) | ≤ 8 GB (8192 MB) |
| 2-hop traversal p95 | < 50 ms |
| Sustained write throughput | ≥ 5,000 ops/s |
| Full recovery (snapshot load + WAL replay + index rebuild) | < 30 s |

## Methodology

- **storage.bench.ts** loads N nodes then E edges in 10k-op transactions
  (group commit), measures load throughput (`(N+E)/loadMs`), samples 2-hop
  traversal latency over 100 random starts (p95), captures heap via
  `process.memoryUsage().heapUsed` after a forced GC, then checkpoints, closes,
  reopens, and times recovery.
- **algo.bench.ts** loads the same graph and times pagerank, weak/strong
  components, louvain, and sampled betweenness (k=64).
- Run with `node --expose-gc --import tsx` so the heap reading is post-GC.

## Results — representative CI scale (SCALE=0.05 → 50k nodes / 250k edges)

> Captured on the M7 sign-off run (replace with your machine's output).

| Metric | Value |
|---|---|
| loadMs | 591 |
| writeOpsPerSec | 507725 |
| p95TwoHopMs | 0.01 |
| heapMb | 151 |
| recoveryMs | 469 |

| Algorithm | ms |
|---|---|
| pagerank x20 | 181 |
| components weak | 178 |
| components strong | 144 |
| louvain | 12868 |
| betweenness k=64 | 7779 |

The `SCALE=0.05` run validates the harness and tracks trends; it is **not** the
release gate (the targets in the table above are defined at `SCALE=1`).

## Results — capacity point (SCALE=1) — signed off 2026-06-24 (v1.1.0)

Run with `ASSERT_BUDGETS=1 SCALE=1` on a 16-core / 18 GB machine (macOS, Node
24.2, `NODE_OPTIONS=--max-old-space-size=10240`). The harness printed
**`all §2 budgets met at capacity point`** (process exit 0):

```json
{"SCALE":1,"nodeCount":1000000,"edgeCount":5000000,"loadMs":22355,"writeOpsPerSec":268394,"p95TwoHopMs":0.1,"heapMb":2926,"recoveryMs":16184}
```

| Metric | Budget | Measured | Margin |
|---|---|---|---|
| Heap (resident graph) | ≤ 8192 MB | **2926 MB** | 2.8× under |
| 2-hop traversal p95 | < 50 ms | **0.10 ms** | 500× under |
| Sustained write throughput | ≥ 5000 ops/s | **268,394 ops/s** | 54× over |
| Full recovery | < 30 s | **16.2 s** | 1.85× under |

> Recovery note: the first measured capacity-point recovery was 39 s (over the
> 30 s budget). Profiling showed edge replay dominated (24 s of ~31 s) because the
> generic `applyOp` path runs per-op index/schema hooks, existence validation,
> and defensive prop clones — all redundant for a trusted snapshot. The recovery
> path now uses `GraphStore.bulkLoad` (skips those for the snapshot) and persists
> the observed-schema summary in the snapshot (rehydrated in O(schema), not by
> rescanning the graph). That cut recovery to **16.2 s** with no change to the
> WAL-replay or live-write paths.

## Release gate (capacity point) — manual, large-runner step

The §2 budgets are asserted only at the capacity point. On a machine with
≥ 8 GB free heap headroom (run Node with a raised old-space if needed):

```bash
pnpm build
NODE_OPTIONS=--max-old-space-size=10240 \
  ASSERT_BUDGETS=1 SCALE=1 \
  node --expose-gc --import tsx packages/core/bench/storage.bench.ts
```

With `ASSERT_BUDGETS=1` and `SCALE=1` the harness throws if heap > 8192 MB, 2-hop
p95 > 50 ms, recovery > 30 s, or write throughput < 5000/s, and prints
`all §2 budgets met at capacity point` on success. This is the v1 release gate;
it is intentionally not part of `pnpm test` (it needs a large runner and minutes
to run).

> **Sign-off status: PASSED.** The capacity-point gate was executed for v1.1.0 on
> 2026-06-24 — see "Results — capacity point (SCALE=1)" above for the full output
> and the per-budget margins. Re-run it on the release runner for each release and
> append the result there.
