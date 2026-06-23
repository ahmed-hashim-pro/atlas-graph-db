import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';
import { GraphStore } from '../src/store.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-schema-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('schema introspection', () => {
  it('tracks labels, property types, and edge-type label distributions', async () => {
    const db = await openDatabase(dir);
    await db.transact((tx) => {
      const ada = tx.createNode(['Person'], { name: 'Ada', born: 1815 });
      const charles = tx.createNode(['Person'], { name: 'Charles' });
      const notes = tx.createNode(['Document'], { title: 'Notes', when: new Date(0) });
      tx.createEdge('WROTE', ada, notes);
      tx.createEdge('KNOWS', ada, charles);
    });
    const s = db.schema();
    const person = s.labels.find((l) => l.label === 'Person')!;
    expect(person.count).toBe(2);
    expect(person.properties.find((p) => p.property === 'name')?.types).toEqual({ string: 2 });
    expect(person.properties.find((p) => p.property === 'born')?.types).toEqual({ number: 1 });
    const doc = s.labels.find((l) => l.label === 'Document')!;
    expect(doc.properties.find((p) => p.property === 'when')?.types).toEqual({ datetime: 1 });
    const wrote = s.edgeTypes.find((t) => t.type === 'WROTE')!;
    expect(wrote.count).toBe(1);
    expect(wrote.from).toEqual({ Person: 1 });
    expect(wrote.to).toEqual({ Document: 1 });
    await db.close();
  });

  it('decrements on prop changes and deletes, pruning empty entries', async () => {
    const db = await openDatabase(dir);
    let a = 0;
    let b = 0;
    await db.transact((tx) => {
      a = tx.createNode(['P'], { x: 1 });
      b = tx.createNode(['P'], { x: 'one' });
      tx.createEdge('T', a, b);
    });
    await db.transact((tx) => {
      tx.setNodeProps(a, {}, ['x']); // remove a's x
      tx.deleteNode(b, { detach: true }); // removes the edge and b
    });
    const s = db.schema();
    const p = s.labels.find((l) => l.label === 'P')!;
    expect(p.count).toBe(1);
    expect(p.properties).toEqual([]); // both x entries gone
    expect(s.edgeTypes).toEqual([]);
    await db.close();
  });

  it('rebuilds identically after reopen (snapshot + WAL)', async () => {
    const db = await openDatabase(dir);
    await db.transact((tx) => {
      const n = tx.createNode(['A'], { k: 1, tags: ['x', 'y'] });
      tx.createEdge('R', n, n);
    });
    await db.checkpoint();
    await db.transact((tx) => void tx.createNode(['B'], { k: '2' }));
    const before = JSON.stringify(db.schema());
    await db.close();
    const db2 = await openDatabase(dir);
    expect(JSON.stringify(db2.schema())).toBe(before);
    await db2.close();
  });
});

describe('schema bulk-load (recovery fast path)', () => {
  function seeded(): GraphStore {
    const s = new GraphStore();
    s.applyOp({ op: 'createNode', id: 1, labels: ['A'], props: { k: 1 } });
    s.applyOp({ op: 'createNode', id: 2, labels: ['A'], props: { k: 'two' } });
    s.applyOp({ op: 'createNode', id: 3, labels: ['B'], props: {} });
    s.applyOp({ op: 'createEdge', id: 1, type: 'R', from: 1, to: 3, props: {} });
    return s;
  }

  it('restores schema from the persisted summary without rescanning the graph', () => {
    const a = seeded();
    const summary = a.schema.summary();
    const b = new GraphStore();
    b.bulkLoad([...a.nodes.values()], [...a.edges.values()], summary);
    expect(JSON.stringify(b.schema.summary())).toBe(JSON.stringify(summary));
  });

  it('rebuilds schema lazily on first read when no summary was persisted', () => {
    const a = seeded();
    const want = JSON.stringify(a.schema.summary());
    const b = new GraphStore();
    b.bulkLoad([...a.nodes.values()], [...a.edges.values()]); // pre-M8 snapshot: no schema
    expect(JSON.stringify(b.schema.summary())).toBe(want);
  });

  it('rebuilds schema lazily on first write, then increments on top', () => {
    const a = seeded();
    const b = new GraphStore();
    b.bulkLoad([...a.nodes.values()], [...a.edges.values()]); // deferred (stale)
    // A write is the first schema-relevant op: it must rebuild the deferred base
    // (3 nodes) and then apply its own delta (a 4th A) on top.
    b.applyOp({ op: 'createNode', id: 4, labels: ['A'], props: { k: 4 } });
    expect(b.schema.summary().labels.find((l) => l.label === 'A')?.count).toBe(3);
  });
});
