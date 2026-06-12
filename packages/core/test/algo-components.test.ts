import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '../src/database.js';

let dir: string;
let db: AtlasDatabase;
let n: number[];

// 0->1->2->0 (a directed 3-cycle), 0->3 (dangling), 4<->5 (2-cycle), 6 isolated.
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-algocomp-'));
  db = await openDatabase(dir);
  await db.transact((tx) => {
    n = Array.from({ length: 7 }, () => tx.createNode(['V'], {}));
    tx.createEdge('R', n[0]!, n[1]!);
    tx.createEdge('R', n[1]!, n[2]!);
    tx.createEdge('R', n[2]!, n[0]!);
    tx.createEdge('R', n[0]!, n[3]!);
    tx.createEdge('R', n[4]!, n[5]!);
    tx.createEdge('R', n[5]!, n[4]!);
  });
});
afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

function groups(rows: { node: number; component: number }[]): Set<string> {
  const byComp = new Map<number, number[]>();
  for (const r of rows) {
    if (!byComp.has(r.component)) byComp.set(r.component, []);
    byComp.get(r.component)!.push(r.node);
  }
  return new Set([...byComp.values()].map((g) => g.sort((a, b) => a - b).join(',')));
}

describe('algo.components', () => {
  it('weak: direction-blind grouping', async () => {
    const rows = await db.algo.components(); // default mode 'weak'
    expect(rows).toHaveLength(7);
    expect(groups(rows)).toEqual(
      new Set([
        [n[0]!, n[1]!, n[2]!, n[3]!].sort((a, b) => a - b).join(','),
        [n[4]!, n[5]!].sort((a, b) => a - b).join(','),
        String(n[6]!),
      ]),
    );
  });

  it('strong: the 3-cycle and the 2-cycle are SCCs; the dangling node is its own', async () => {
    const rows = await db.algo.components({ mode: 'strong' });
    expect(rows).toHaveLength(7);
    expect(groups(rows)).toEqual(
      new Set([
        [n[0]!, n[1]!, n[2]!].sort((a, b) => a - b).join(','),
        [n[4]!, n[5]!].sort((a, b) => a - b).join(','),
        String(n[3]!),
        String(n[6]!),
      ]),
    );
  });
});
