import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '../src/database.js';

let dir: string;
let db: AtlasDatabase;
let n: number[];

// Diamond with a tail: 0->1, 0->2, 1->3, 2->3, 3->4 (all REL), plus 5 isolated.
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-algotrav-'));
  db = await openDatabase(dir);
  await db.transact((tx) => {
    n = Array.from({ length: 6 }, () => tx.createNode(['V'], {}));
    tx.createEdge('REL', n[0]!, n[1]!);
    tx.createEdge('REL', n[0]!, n[2]!);
    tx.createEdge('REL', n[1]!, n[3]!);
    tx.createEdge('REL', n[2]!, n[3]!);
    tx.createEdge('REL', n[3]!, n[4]!);
    tx.createEdge('OTHER', n[4]!, n[5]!);
  });
});
afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('algo.bfs', () => {
  it('yields nodes with hop depths, each node once', async () => {
    const out = await db.algo.bfs({ from: n[0]! });
    const byNode = new Map(out.map((r) => [r.node, r.depth]));
    expect(byNode.get(n[0]!)).toBe(0);
    expect(byNode.get(n[1]!)).toBe(1);
    expect(byNode.get(n[2]!)).toBe(1);
    expect(byNode.get(n[3]!)).toBe(2);
    expect(byNode.get(n[4]!)).toBe(3);
    expect(byNode.get(n[5]!)).toBe(4); // via OTHER edge
    expect(out).toHaveLength(6);
  });

  it('respects maxDepth, type filter, and direction', async () => {
    expect(await db.algo.bfs({ from: n[0]!, maxDepth: 1 })).toHaveLength(3);
    expect((await db.algo.bfs({ from: n[0]!, type: 'REL' })).map((r) => r.node)).not.toContain(
      n[5]!,
    );
    const up = await db.algo.bfs({ from: n[3]!, direction: 'in', type: 'REL' });
    expect(up.map((r) => r.node).sort()).toEqual([n[0]!, n[1]!, n[2]!, n[3]!].sort());
  });

  it('rejects a missing start node with NOT_FOUND', async () => {
    await expect(db.algo.bfs({ from: 99_999 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('algo.dfs', () => {
  it('visits every reachable node exactly once with depths', async () => {
    const out = await db.algo.dfs({ from: n[0]!, type: 'REL' });
    expect(out.map((r) => r.node).sort()).toEqual([n[0]!, n[1]!, n[2]!, n[3]!, n[4]!].sort());
    expect(out.find((r) => r.node === n[0]!)?.depth).toBe(0);
    expect(out.filter((r) => r.node === n[3]!)).toHaveLength(1);
  });
});

describe('algo.degree', () => {
  it('scores by direction', async () => {
    const both = new Map((await db.algo.degree()).map((r) => [r.node, r.score]));
    expect(both.get(n[3]!)).toBe(3);
    expect(both.get(n[5]!)).toBe(1);
    const out = new Map((await db.algo.degree({ direction: 'out' })).map((r) => [r.node, r.score]));
    expect(out.get(n[0]!)).toBe(2);
    expect(out.get(n[4]!)).toBe(1);
    expect(out.get(n[5]!)).toBe(0);
  });

  it('aborts with TIMEOUT when the budget is exhausted', async () => {
    // budgetMs: 0 expires the lease before the first tick fires.
    await expect(db.algo.degree({ budgetMs: 0 })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
