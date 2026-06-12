import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '../src/database.js';

let dir: string;
let db: AtlasDatabase;
let n: number[];

// Weighted square + shortcut: 0-1 (1), 1-3 (1), 0-2 (5), 2-3 (1), 0-3 (10 direct).
// Unweighted: two distinct 2-hop paths 0->3 plus the 1-hop direct edge.
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-algopaths-'));
  db = await openDatabase(dir);
  await db.transact((tx) => {
    n = Array.from({ length: 5 }, () => tx.createNode(['V'], {}));
    tx.createEdge('R', n[0]!, n[1]!, { w: 1 });
    tx.createEdge('R', n[1]!, n[3]!, { w: 1 });
    tx.createEdge('R', n[0]!, n[2]!, { w: 5 });
    tx.createEdge('R', n[2]!, n[3]!, { w: 1 });
    tx.createEdge('R', n[0]!, n[3]!, { w: 10 });
    // n[4] is unreachable from n[0].
    tx.createEdge('R', n[4]!, n[0]!, { w: 1 });
  });
});
afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('algo.shortestPath', () => {
  it('unweighted: fewest hops wins (the direct edge)', async () => {
    const r = await db.algo.shortestPath({ from: n[0]!, to: n[3]! });
    expect(r).not.toBeNull();
    expect(r!.cost).toBe(1);
    expect(r!.path.nodes).toEqual([n[0]!, n[3]!]);
    expect(r!.path.edges).toHaveLength(1);
  });

  it('weighted: cheapest total weight wins', async () => {
    const r = await db.algo.shortestPath({ from: n[0]!, to: n[3]!, weightProp: 'w' });
    expect(r!.cost).toBe(2);
    expect(r!.path.nodes).toEqual([n[0]!, n[1]!, n[3]!]);
  });

  it('returns null when unreachable; rejects negative weights', async () => {
    expect(await db.algo.shortestPath({ from: n[0]!, to: n[4]! })).toBeNull();
    await db.transact((tx) => void tx.createEdge('R', n[0]!, n[4]!, { w: -2 }));
    await expect(
      db.algo.shortestPath({ from: n[0]!, to: n[4]!, weightProp: 'w' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    // restore graph for later tests by removing that edge
    const bad = db.outEdges(n[0]!).find((e) => e.props.w === -2)!;
    await db.transact((tx) => void tx.deleteEdge(bad.id));
  });

  it('A*: a consistent heuristic finds the same cost', async () => {
    const h = (id: number): number => (id === n[3]! ? 0 : 1);
    const r = await db.algo.shortestPath({ from: n[0]!, to: n[3]!, weightProp: 'w', heuristic: h });
    expect(r!.cost).toBe(2);
  });
});

describe('algo.allShortestPaths', () => {
  it('returns every minimal-hop path', async () => {
    // Remove the direct 0->3 edge so the two 2-hop routes tie.
    const direct = db.outEdges(n[0]!).find((e) => e.to === n[3]! && e.props.w === 10)!;
    await db.transact((tx) => void tx.deleteEdge(direct.id));
    const rs = await db.algo.allShortestPaths({ from: n[0]!, to: n[3]! });
    expect(rs).toHaveLength(2);
    for (const r of rs) {
      expect(r.cost).toBe(2);
      expect(r.path.nodes[0]).toBe(n[0]!);
      expect(r.path.nodes.at(-1)).toBe(n[3]!);
    }
    const middles = rs.map((r) => r.path.nodes[1]).sort();
    expect(middles).toEqual([n[1]!, n[2]!].sort());
  });

  it('returns [] when unreachable', async () => {
    expect(await db.algo.allShortestPaths({ from: n[1]!, to: n[4]! })).toEqual([]);
  });
});
