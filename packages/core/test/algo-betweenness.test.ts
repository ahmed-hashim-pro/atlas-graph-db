import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '../src/database.js';

let dir: string;
let db: AtlasDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-algobc-'));
  db = await openDatabase(dir);
});
afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('algo.betweenness', () => {
  it('directed path: interior nodes carry exact pair counts', async () => {
    let n: number[] = [];
    await db.transact((tx) => {
      n = Array.from({ length: 5 }, () => tx.createNode(['V'], {}));
      for (let i = 0; i < 4; i++) tx.createEdge('R', n[i]!, n[i + 1]!);
    });
    const score = new Map((await db.algo.betweenness()).map((r) => [r.node, r.score]));
    // Ordered (s,t) pairs whose shortest path passes through w:
    expect(score.get(n[0]!)).toBe(0);
    expect(score.get(n[1]!)).toBe(3); // (0,2) (0,3) (0,4)
    expect(score.get(n[2]!)).toBe(4); // (0,3) (0,4) (1,3) (1,4)
    expect(score.get(n[3]!)).toBe(3); // (0,4) (1,4) (2,4)
    expect(score.get(n[4]!)).toBe(0);
  });

  it('split shortest paths share credit', async () => {
    let n: number[] = [];
    await db.transact((tx) => {
      n = Array.from({ length: 4 }, () => tx.createNode(['V'], {}));
      tx.createEdge('R', n[0]!, n[1]!);
      tx.createEdge('R', n[0]!, n[2]!);
      tx.createEdge('R', n[1]!, n[3]!);
      tx.createEdge('R', n[2]!, n[3]!);
    });
    const score = new Map((await db.algo.betweenness()).map((r) => [r.node, r.score]));
    expect(score.get(n[1]!)).toBeCloseTo(0.5, 9); // two equal 0->3 paths split the credit
    expect(score.get(n[2]!)).toBeCloseTo(0.5, 9);
  });

  it('sampleK = n matches the exact computation', async () => {
    let n: number[] = [];
    await db.transact((tx) => {
      n = Array.from({ length: 5 }, () => tx.createNode(['V'], {}));
      for (let i = 0; i < 4; i++) tx.createEdge('R', n[i]!, n[i + 1]!);
    });
    const exact = await db.algo.betweenness();
    const sampled = await db.algo.betweenness({ sampleK: 5 });
    expect(sampled).toEqual(exact);
  });

  it('the exact guard switches to scaled sampling', async () => {
    await db.transact((tx) => {
      const hub = tx.createNode(['V'], {});
      for (let i = 0; i < 20; i++) {
        const a = tx.createNode(['V'], {});
        const b = tx.createNode(['V'], {});
        tx.createEdge('R', a, hub);
        tx.createEdge('R', hub, b);
      }
    });
    const rows = await db.algo.betweenness({ exactGuard: 10, sampleK: 11 });
    const top = rows.reduce((best, r) => (r.score > best.score ? r : best));
    const hubId = Math.min(...rows.map((r) => r.node));
    expect(top.node).toBe(hubId); // the hub dominates even under sampling
  });
});
