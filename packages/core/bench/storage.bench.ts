// Storage benchmark vs spec §2 targets (capacity point: 1M nodes / 5M edges, SCALE=1).
// Usage: SCALE=0.05 [ASSERT_BUDGETS=1] node --expose-gc --import tsx packages/core/bench/storage.bench.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateGraph } from '@atlas/datasets';
import { openDatabase } from '../src/database.js';

const SCALE = Number(process.env.SCALE ?? '0.05');
const ASSERT = process.env.ASSERT_BUDGETS === '1';
const N = Math.round(1_000_000 * SCALE);
const E = Math.round(5_000_000 * SCALE);
const BATCH = 10_000;

function heapMb(): number {
  globalThis.gc?.();
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
}

const dir = await mkdtemp(join(tmpdir(), 'atlas-bench-'));
try {
  console.log(`atlas storage bench — SCALE=${SCALE} → ${N} nodes / ${E} edges`);
  const graph = generateGraph({ nodes: N, edges: E, seed: 42 });
  const db = await openDatabase(dir, { snapshotWalBytes: 512 * 1024 * 1024 });

  // 1) Load throughput.
  const nodeIds = new Array<number>(N);
  const t0 = performance.now();
  for (let i = 0; i < N; i += BATCH) {
    await db.transact((tx) => {
      for (let j = i; j < Math.min(i + BATCH, N); j++)
        nodeIds[j] = tx.createNode(graph.nodes[j]!.labels, graph.nodes[j]!.props);
    });
  }
  for (let i = 0; i < E; i += BATCH) {
    await db.transact((tx) => {
      for (let j = i; j < Math.min(i + BATCH, E); j++) {
        const e = graph.edges[j]!;
        tx.createEdge(e.type, nodeIds[e.from]!, nodeIds[e.to]!, e.props);
      }
    });
  }
  const loadMs = performance.now() - t0;
  const writeOpsPerSec = Math.round((N + E) / (loadMs / 1000));

  // 2) 2-hop traversal latency (100 random starts).
  const latencies: number[] = [];
  for (let i = 0; i < 100; i++) {
    const start = nodeIds[(i * 9973) % N]!;
    const t = performance.now();
    let touched = 0;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const e1 of db.outEdges(start)) for (const _e2 of db.outEdges(e1.to)) touched++;
    latencies.push(performance.now() - t);
    if (touched < 0) throw new Error('unreachable');
  }
  latencies.sort((a, b) => a - b);
  const p95 = latencies[Math.floor(latencies.length * 0.95)]!;

  // 3) Memory + recovery.
  const heap = heapMb();
  await db.checkpoint();
  await db.close();
  const tR = performance.now();
  const db2 = await openDatabase(dir);
  const recoveryMs = Math.round(performance.now() - tR);
  const stats = db2.stats();
  await db2.close();

  const report = {
    SCALE,
    ...stats,
    loadMs: Math.round(loadMs),
    writeOpsPerSec,
    p95TwoHopMs: +p95.toFixed(2),
    heapMb: heap,
    recoveryMs,
  };
  console.table([report]);
  console.log(JSON.stringify(report));

  if (ASSERT && SCALE === 1) {
    if (heap > 8192) throw new Error(`heap budget exceeded: ${heap} MB > 8192 MB`);
    if (p95 > 50) throw new Error(`2-hop p95 budget exceeded: ${p95} ms > 50 ms`);
    if (recoveryMs > 30_000) throw new Error(`recovery budget exceeded: ${recoveryMs} ms > 30 s`);
    if (writeOpsPerSec < 5000)
      throw new Error(`write throughput below budget: ${writeOpsPerSec}/s < 5000/s`);
    console.log('all §2 budgets met at capacity point');
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
