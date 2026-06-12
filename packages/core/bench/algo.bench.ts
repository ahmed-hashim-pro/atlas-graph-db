// Algorithm benchmark over a synthetic graph.
// Usage: SCALE=0.05 node --expose-gc --import tsx packages/core/bench/algo.bench.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateGraph } from '@atlas/datasets';
import { openDatabase } from '../src/database.js';

const SCALE = Number(process.env.SCALE ?? '0.05');
const N = Math.round(1_000_000 * SCALE);
const E = Math.round(5_000_000 * SCALE);
const BATCH = 10_000;

const dir = await mkdtemp(join(tmpdir(), 'atlas-algobench-'));
try {
  console.log(`atlas algo bench — SCALE=${SCALE} → ${N} nodes / ${E} edges`);
  const graph = generateGraph({ nodes: N, edges: E, seed: 42 });
  const db = await openDatabase(dir, {
    fsync: { intervalMs: 5000 },
    snapshotWalBytes: 1024 * 1024 * 1024,
  });
  const ids = new Array<number>(N);
  for (let i = 0; i < N; i += BATCH)
    await db.transact((tx) => {
      for (let j = i; j < Math.min(i + BATCH, N); j++)
        ids[j] = tx.createNode(graph.nodes[j]!.labels, graph.nodes[j]!.props);
    });
  for (let i = 0; i < E; i += BATCH)
    await db.transact((tx) => {
      for (let j = i; j < Math.min(i + BATCH, E); j++) {
        const e = graph.edges[j]!;
        tx.createEdge(e.type, ids[e.from]!, ids[e.to]!);
      }
    });

  const timed = async (
    name: string,
    fn: () => Promise<unknown>,
  ): Promise<Record<string, unknown>> => {
    const t = performance.now();
    await fn();
    return { name, ms: Math.round(performance.now() - t) };
  };
  const budget = { budgetMs: 600_000 };
  const results = [
    await timed('pagerank x20', () => db.algo.pagerank(budget)),
    await timed('components weak', () => db.algo.components({ ...budget })),
    await timed('components strong', () => db.algo.components({ mode: 'strong', ...budget })),
    await timed('louvain', () => db.algo.louvain(budget)),
    await timed('betweenness k=64', () => db.algo.betweenness({ sampleK: 64, ...budget })),
  ];
  console.table(results);
  await db.close();
} finally {
  await rm(dir, { recursive: true, force: true });
}
