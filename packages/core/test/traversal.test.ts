import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '../src/database.js';

let dir: string;
let db: AtlasDatabase;
let ids: { ada: number; charles: number; marie: number; notes: number; engine: number };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-trav-'));
  db = await openDatabase(dir);
  await db.transact((tx) => {
    const ada = tx.createNode(['Person'], { name: 'Ada', born: 1815 });
    const charles = tx.createNode(['Person'], { name: 'Charles', born: 1791 });
    const marie = tx.createNode(['Person'], { name: 'Marie', born: 1867 });
    const notes = tx.createNode(['Document'], { title: 'Notes', year: 1843 });
    const engine = tx.createNode(['Concept'], { name: 'Analytical Engine' });
    tx.createEdge('KNOWS', ada, charles);
    tx.createEdge('WROTE', ada, notes);
    tx.createEdge('CITES', notes, engine);
    tx.createEdge('INVENTED', charles, engine);
    ids = { ada, charles, marie, notes, engine };
  });
});
afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('fluent traversal — nodes', () => {
  it('spec shape: nodes(label).where(props).out(type).toArray()', () => {
    const g = db.graph();
    const docs = g
      .nodes('Person')
      .where((p) => (p.born as number) > 1800)
      .out('WROTE')
      .toArray();
    expect(docs.map((d) => d.id)).toEqual([ids.notes]);
  });

  it('is lazy: limit() stops pulling from the source', () => {
    const g = db.graph();
    let predCalls = 0;
    const got = g
      .nodes('Person')
      .where(() => {
        predCalls++;
        return true;
      })
      .limit(1)
      .toArray();
    expect(got).toHaveLength(1);
    expect(predCalls).toBe(1);
  });

  it('out/in/both hop with optional type filter', () => {
    const g = db.graph();
    expect(g.node(ids.ada).out().count()).toBe(2);
    expect(
      g
        .node(ids.ada)
        .out('KNOWS')
        .toArray()
        .map((n) => n.id),
    ).toEqual([ids.charles]);
    expect(g.node(ids.engine).in().count()).toBe(2);
    expect(g.node(ids.charles).both().count()).toBe(2); // ada (in via KNOWS), engine (out)
  });

  it('dedup, skip, order, first, count compose', () => {
    const g = db.graph();
    // ada and charles both reach engine: notes->engine via cites? No — ada->notes->? two-hop;
    // use in()-side: engine.in() = [notes(CITES), charles(INVENTED)]
    const names = g
      .nodes('Person')
      .order((a, b) => (a.props.born as number) - (b.props.born as number))
      .toArray()
      .map((n) => n.props.name);
    expect(names).toEqual(['Charles', 'Ada', 'Marie']);
    expect(
      g
        .nodes('Person')
        .order((a, b) => (a.props.born as number) - (b.props.born as number))
        .skip(1)
        .first()?.props.name,
    ).toBe('Ada');
    expect(g.node(ids.ada).out().out().dedup().count()).toBe(1); // engine reached once via notes
    expect(g.nodes('Nope').count()).toBe(0);
  });

  it('node(id) of a missing id is an empty traversal', () => {
    expect(db.graph().node(999_999).toArray()).toEqual([]);
  });
});
