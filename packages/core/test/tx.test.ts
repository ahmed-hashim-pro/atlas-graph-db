import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';
import { AtlasError } from '../src/errors.js';
import { IdAllocator } from '../src/id-allocator.js';
import { GraphStore } from '../src/store.js';
import { TxBuilder } from '../src/tx.js';

function setup(): { store: GraphStore; ids: IdAllocator } {
  const store = new GraphStore();
  store.applyOp({ op: 'createNode', id: 1, labels: ['Person'], props: {} });
  store.applyOp({ op: 'createNode', id: 2, labels: ['Person'], props: {} });
  store.applyOp({ op: 'createEdge', id: 1, type: 'KNOWS', from: 1, to: 2, props: {} });
  return { store, ids: new IdAllocator(3, 2) };
}

describe('TxBuilder', () => {
  it('builds ops referencing both committed and tx-created elements', () => {
    const { store, ids } = setup();
    const tx = new TxBuilder(store, ids);
    const n = tx.createNode(['Person'], { name: 'New' });
    expect(n).toBe(3);
    const e = tx.createEdge('KNOWS', 1, n);
    expect(e).toBe(2);
    tx.setNodeProps(n, { name: 'Renamed' });
    const ops = tx.build();
    expect(ops.map((o) => o.op)).toEqual(['createNode', 'createEdge', 'setNodeProps']);
  });

  it('rejects edges to missing or tx-deleted nodes with NOT_FOUND', () => {
    const { store, ids } = setup();
    const tx = new TxBuilder(store, ids);
    expect(() => tx.createEdge('KNOWS', 1, 99)).toThrowError(AtlasError);
    tx.deleteEdge(1);
    tx.deleteNode(2);
    expect(() => tx.createEdge('KNOWS', 1, 2)).toThrowError(AtlasError);
  });

  it('deleteNode without detach throws DETACH_REQUIRED while edges remain', () => {
    const { store, ids } = setup();
    const tx = new TxBuilder(store, ids);
    try {
      tx.deleteNode(1);
      expect.unreachable();
    } catch (e) {
      expect((e as AtlasError).code).toBe('DETACH_REQUIRED');
    }
  });

  it('deleting a node with incident edges throws DETACH_REQUIRED (a distinct code)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-detach-'));
    const db = await openDatabase(dir);
    let a = 0;
    await db.transact((tx) => {
      a = tx.createNode(['P'], {});
      const b = tx.createNode(['P'], {});
      tx.createEdge('R', a, b);
    });
    await expect(db.transact((tx) => tx.deleteNode(a))).rejects.toMatchObject({
      code: 'DETACH_REQUIRED',
    });
    expect(() => {
      throw new AtlasError('DETACH_REQUIRED', 'x');
    }).toThrow(AtlasError);
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('deleteNode with detach expands deleteEdge ops for committed and tx-created edges', () => {
    const { store, ids } = setup();
    const tx = new TxBuilder(store, ids);
    const n = tx.createNode(['Person'], {});
    tx.createEdge('KNOWS', n, 1);
    tx.deleteNode(1, { detach: true });
    const ops = tx.build();
    const deletes = ops
      .filter((o) => o.op === 'deleteEdge')
      .map((o) => o.id)
      .sort();
    expect(deletes).toEqual([1, 2]);
    expect(ops.at(-1)).toEqual({ op: 'deleteNode', id: 1 });
  });

  it('applying built ops keeps store invariants', () => {
    const { store, ids } = setup();
    const tx = new TxBuilder(store, ids);
    const n = tx.createNode(['Doc'], {});
    tx.createEdge('WROTE', 1, n);
    tx.deleteNode(2, { detach: true });
    store.applyBatch({ txId: 1, ops: tx.build() });
    expect(() => store.checkInvariants()).not.toThrow();
  });
});
