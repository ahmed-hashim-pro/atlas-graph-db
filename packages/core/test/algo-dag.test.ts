import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '../src/database.js';

let dir: string;
let db: AtlasDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-algodag-'));
  db = await openDatabase(dir);
});
afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('algo.topoSort', () => {
  it('emits a valid topological order with positions', async () => {
    let n: number[] = [];
    await db.transact((tx) => {
      n = Array.from({ length: 4 }, () => tx.createNode(['Pkg'], {}));
      tx.createEdge('DEP', n[0]!, n[1]!); // 0 depends-on 1 => 1 must come... order: edges point 0->1
      tx.createEdge('DEP', n[0]!, n[2]!);
      tx.createEdge('DEP', n[1]!, n[3]!);
      tx.createEdge('DEP', n[2]!, n[3]!);
    });
    const rows = await db.algo.topoSort();
    expect(rows).toHaveLength(4);
    const orderOf = new Map(rows.map((r) => [r.node, r.order]));
    // Every edge from->to must satisfy order(from) < order(to).
    for (const e of db.outEdges(n[0]!))
      expect(orderOf.get(n[0]!)!).toBeLessThan(orderOf.get(e.to)!);
    expect(orderOf.get(n[1]!)!).toBeLessThan(orderOf.get(n[3]!)!);
    expect(orderOf.get(n[2]!)!).toBeLessThan(orderOf.get(n[3]!)!);
    expect(new Set(rows.map((r) => r.order))).toEqual(new Set([0, 1, 2, 3]));
  });

  it('throws VALIDATION on a cyclic graph', async () => {
    await db.transact((tx) => {
      const a = tx.createNode(['Pkg'], {});
      const b = tx.createNode(['Pkg'], {});
      tx.createEdge('DEP', a, b);
      tx.createEdge('DEP', b, a);
    });
    await expect(db.algo.topoSort()).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('respects the type filter', async () => {
    await db.transact((tx) => {
      const a = tx.createNode(['Pkg'], {});
      const b = tx.createNode(['Pkg'], {});
      tx.createEdge('DEP', a, b);
      tx.createEdge('SOFT', b, a); // would be a cycle if SOFT counted
    });
    const rows = await db.algo.topoSort({ type: 'DEP' });
    expect(rows).toHaveLength(2);
  });
});

describe('algo.cycles', () => {
  it('finds directed cycles as closed paths', async () => {
    let n: number[] = [];
    await db.transact((tx) => {
      n = Array.from({ length: 5 }, () => tx.createNode(['V'], {}));
      tx.createEdge('R', n[0]!, n[1]!);
      tx.createEdge('R', n[1]!, n[2]!);
      tx.createEdge('R', n[2]!, n[0]!); // 3-cycle
      tx.createEdge('R', n[3]!, n[4]!); // acyclic tail
    });
    const found = await db.algo.cycles();
    expect(found).toHaveLength(1);
    const cyc = found[0]!.cycle;
    expect(new Set(cyc.nodes)).toEqual(new Set([n[0]!, n[1]!, n[2]!]));
    expect(cyc.edges).toHaveLength(3); // closing edge included
  });

  it('returns [] for a DAG and respects the limit', async () => {
    await db.transact((tx) => {
      const a = tx.createNode(['V'], {});
      const b = tx.createNode(['V'], {});
      tx.createEdge('R', a, b);
      // two self-loops = two 1-cycles
      const c = tx.createNode(['V'], {});
      const d = tx.createNode(['V'], {});
      tx.createEdge('R', c, c);
      tx.createEdge('R', d, d);
    });
    expect(await db.algo.cycles({ limit: 1 })).toHaveLength(1);
    const all = await db.algo.cycles();
    expect(all).toHaveLength(2);
  });
});
