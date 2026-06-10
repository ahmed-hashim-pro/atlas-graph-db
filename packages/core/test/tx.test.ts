import { describe, expect, it } from 'vitest';
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

  it('deleteNode without detach throws VALIDATION while edges remain', () => {
    const { store, ids } = setup();
    const tx = new TxBuilder(store, ids);
    try {
      tx.deleteNode(1);
      expect.unreachable();
    } catch (e) {
      expect((e as AtlasError).code).toBe('VALIDATION');
    }
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
