import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { louvain } from '../src/algo/louvain.js';
import { Ticker } from '../src/algo/runner.js';
import { openDatabase, type AtlasDatabase } from '../src/database.js';
import { GraphStore } from '../src/store.js';

let dir: string;
let db: AtlasDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-algolv-'));
  db = await openDatabase(dir);
});
afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

async function clique(size: number): Promise<number[]> {
  const ids: number[] = [];
  await db.transact((tx) => {
    for (let i = 0; i < size; i++) ids.push(tx.createNode(['V'], {}));
    for (let i = 0; i < size; i++)
      for (let j = i + 1; j < size; j++) tx.createEdge('R', ids[i]!, ids[j]!);
  });
  return ids;
}

describe('algo.louvain', () => {
  it('two cliques joined by one bridge edge form two communities', async () => {
    const a = await clique(5);
    const b = await clique(5);
    await db.transact((tx) => void tx.createEdge('R', a[0]!, b[0]!));
    const rows = await db.algo.louvain();
    const comm = new Map(rows.map((r) => [r.node, r.community]));
    const aComms = new Set(a.map((id) => comm.get(id)));
    const bComms = new Set(b.map((id) => comm.get(id)));
    expect(aComms.size).toBe(1);
    expect(bComms.size).toBe(1);
    expect([...aComms][0]).not.toBe([...bComms][0]);
  });

  it('a single clique is one community', async () => {
    await clique(6);
    const rows = await db.algo.louvain();
    expect(new Set(rows.map((r) => r.community)).size).toBe(1);
  });

  it('edge-free nodes each get their own community; empty graph returns []', async () => {
    expect(await db.algo.louvain()).toEqual([]);
    await db.transact((tx) => {
      tx.createNode(['V'], {});
      tx.createNode(['V'], {});
    });
    const rows = await db.algo.louvain();
    expect(new Set(rows.map((r) => r.community)).size).toBe(2);
  });

  it('resolves on a large graph without overflowing the call stack', async () => {
    // Regression: spreading ~200k communities into Math.max(...communities) threw
    // RangeError (max call stack). localMove now returns a dense `count` instead.
    const N = 200_000;
    const store = new GraphStore();
    for (let i = 0; i < N; i++)
      store.applyOp({ op: 'createNode', id: i, labels: ['V'], props: {} });
    // Deterministic ring plus a deterministic chord per node -> ~200k edges, no RNG.
    for (let i = 0; i < N; i++) {
      const to = (i * 2 + 1) % N;
      store.applyOp({ op: 'createEdge', id: i, type: 'R', from: i, to, props: {} });
    }
    const ticker = new Ticker({ release() {}, expired: false });
    const rows = await louvain(store, ticker);
    expect(rows.length).toBe(N);
  }, 120_000);
});
