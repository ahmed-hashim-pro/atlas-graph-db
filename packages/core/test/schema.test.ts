import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';

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
