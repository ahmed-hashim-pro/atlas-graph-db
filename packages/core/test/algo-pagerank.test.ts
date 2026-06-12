import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '../src/database.js';

let dir: string;
let db: AtlasDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-algopr-'));
  db = await openDatabase(dir);
});
afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('algo.pagerank', () => {
  it('a symmetric cycle converges to uniform scores summing to 1', async () => {
    let n: number[] = [];
    await db.transact((tx) => {
      n = Array.from({ length: 3 }, () => tx.createNode(['V'], {}));
      tx.createEdge('R', n[0]!, n[1]!);
      tx.createEdge('R', n[1]!, n[2]!);
      tx.createEdge('R', n[2]!, n[0]!);
    });
    const rows = await db.algo.pagerank();
    expect(rows).toHaveLength(3);
    const total = rows.reduce((s, r) => s + r.score, 0);
    expect(total).toBeCloseTo(1, 6);
    for (const r of rows) expect(r.score).toBeCloseTo(1 / 3, 6);
  });

  it('a sink hub outranks its pointers; dangling mass is redistributed (sum stays 1)', async () => {
    let hub = 0;
    const leaves: number[] = [];
    await db.transact((tx) => {
      hub = tx.createNode(['V'], {});
      for (let i = 0; i < 4; i++) {
        const leaf = tx.createNode(['V'], {});
        leaves.push(leaf);
        tx.createEdge('R', leaf, hub);
      }
    });
    const rows = await db.algo.pagerank({ iterations: 30 });
    const score = new Map(rows.map((r) => [r.node, r.score]));
    for (const leaf of leaves) expect(score.get(hub)!).toBeGreaterThan(score.get(leaf)!);
    expect(rows.reduce((s, r) => s + r.score, 0)).toBeCloseTo(1, 6);
  });

  it('rejects invalid damping', async () => {
    await db.transact((tx) => void tx.createNode(['V'], {}));
    await expect(db.algo.pagerank({ damping: 1.5 })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('empty graph returns []', async () => {
    expect(await db.algo.pagerank()).toEqual([]);
  });
});
