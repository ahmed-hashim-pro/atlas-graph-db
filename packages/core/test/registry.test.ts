import { describe, expect, it } from 'vitest';
import { AtlasError } from '../src/errors.js';
import { IdAllocator } from '../src/id-allocator.js';
import { GraphStore } from '../src/store.js';
import { TxBuilder } from '../src/tx.js';

function seeded(): GraphStore {
  const s = new GraphStore();
  s.applyOp({ op: 'createNode', id: 1, labels: ['Person'], props: { name: 'Ada', born: 1815 } });
  s.applyOp({
    op: 'createNode',
    id: 2,
    labels: ['Person'],
    props: { name: 'Charles', born: 1791 },
  });
  s.applyOp({ op: 'createNode', id: 3, labels: ['Document'], props: { title: 'Notes' } });
  return s;
}

describe('index ops through GraphStore', () => {
  it('createIndex backfills existing nodes (label-scoped, multi-label aware)', () => {
    const s = seeded();
    s.applyOp({ op: 'createIndex', def: { kind: 'property', label: 'Person', property: 'born' } });
    expect([...(s.indexes.lookupExact('Person', 'born', 1815) ?? [])]).toEqual([1]);
    expect([...s.indexes.lookupRange('Person', 'born', { gte: 1800 })]).toEqual([1]);
    expect(s.indexes.lookupExact('Document', 'born', 1815)).toBeUndefined(); // no such index
  });

  it('maintains postings across create/set/remove/delete', () => {
    const s = seeded();
    s.applyOp({ op: 'createIndex', def: { kind: 'property', label: 'Person', property: 'born' } });
    s.applyOp({ op: 'createNode', id: 4, labels: ['Person'], props: { born: 1809 } });
    expect([...s.indexes.lookupRange('Person', 'born', { lt: 1815 })]).toEqual([2, 4]);
    s.applyOp({ op: 'setNodeProps', id: 4, set: { born: 1882 }, remove: [] });
    expect([...s.indexes.lookupRange('Person', 'born', { gt: 1815 })]).toEqual([4]);
    s.applyOp({ op: 'setNodeProps', id: 4, set: {}, remove: ['born'] });
    expect([...s.indexes.lookupRange('Person', 'born', { gt: 1815 })]).toEqual([]);
    s.applyOp({ op: 'deleteNode', id: 3 }); // unindexed label — must not throw
  });

  it('fulltext indexes answer searchText and dropIndex removes lookups', () => {
    const s = seeded();
    s.applyOp({
      op: 'createIndex',
      def: { kind: 'fulltext', label: 'Document', property: 'title' },
    });
    expect([...s.indexes.searchText('Document', 'title', 'notes')!]).toEqual([3]);
    s.applyOp({ op: 'dropIndex', def: { kind: 'fulltext', label: 'Document', property: 'title' } });
    expect(s.indexes.searchText('Document', 'title', 'notes')).toBeUndefined();
  });
});

describe('TxBuilder index DDL', () => {
  it('stages createIndex/dropIndex with duplicate/missing validation', () => {
    const s = seeded();
    const tx = new TxBuilder(s, new IdAllocator(10, 10));
    const def = { kind: 'property', label: 'Person', property: 'born' } as const;
    tx.createIndex(def);
    expect(() => tx.createIndex(def)).toThrowError(AtlasError); // duplicate within tx
    tx.dropIndex(def); // staged create can be dropped
    expect(() => tx.dropIndex(def)).toThrowError(AtlasError); // now missing
    expect(tx.build().map((o) => o.op)).toEqual(['createIndex', 'dropIndex']);
  });

  it('rejects malformed defs', () => {
    const s = seeded();
    const tx = new TxBuilder(s, new IdAllocator(10, 10));
    expect(() => tx.createIndex({ kind: 'property', label: '', property: 'x' })).toThrowError(
      AtlasError,
    );
    expect(() => tx.createIndex({ kind: 'nope' as never, label: 'A', property: 'x' })).toThrowError(
      AtlasError,
    );
  });
});
