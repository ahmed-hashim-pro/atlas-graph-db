import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '../src/database.js';
import { AtlasError } from '../src/errors.js';

let dir: string;
let db: AtlasDatabase;
let ids: Record<string, number>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-trav2-'));
  db = await openDatabase(dir);
  ids = {};
  await db.transact((tx) => {
    tx.createIndex({ kind: 'property', label: 'Person', property: 'born' });
    tx.createIndex({ kind: 'fulltext', label: 'Document', property: 'title' });
    ids.ada = tx.createNode(['Person'], { name: 'Ada', born: 1815 });
    ids.charles = tx.createNode(['Person'], { name: 'Charles', born: 1791 });
    ids.notes = tx.createNode(['Document'], { title: 'Notes on the Analytical Engine' });
    tx.createEdge('WROTE', ids.ada, ids.notes, { year: 1843 });
    tx.createEdge('KNOWS', ids.ada, ids.charles, { since: 1833 });
  });
});
afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('index-backed sources', () => {
  it('nodesWhere serves exact and range queries from the index', () => {
    const g = db.graph();
    expect(g.nodesWhere('Person', 'born', 1815).toArray().map((n) => n.id)).toEqual([ids.ada]);
    expect(g.nodesWhere('Person', 'born', { lt: 1800 }).toArray().map((n) => n.id)).toEqual([
      ids.charles,
    ]);
  });

  it('nodesWhere without an index throws NOT_FOUND (no silent scans)', () => {
    expect(() => db.graph().nodesWhere('Person', 'name', 'Ada').toArray()).toThrowError(AtlasError);
  });

  it('search() rides the fulltext index, prefix mode included', () => {
    const g = db.graph();
    expect(g.search('Document', 'title', 'analytical engine').toArray().map((n) => n.id)).toEqual([
      ids.notes,
    ]);
    expect(g.search('Document', 'title', 'anal', { prefix: true }).count()).toBe(1);
    expect(() => g.search('Document', 'nope', 'x').toArray()).toThrowError(AtlasError);
  });
});

describe('edge steps and paths', () => {
  it('outE/where-on-edge-props/toNode composes', () => {
    const g = db.graph();
    const got = g
      .node(ids.ada)
      .outE()
      .where((p) => (p.year as number) === 1843)
      .toNode()
      .toArray();
    expect(got.map((n) => n.id)).toEqual([ids.notes]);
  });

  it('paths() returns the full route', () => {
    const paths = db.graph().node(ids.ada).out('WROTE').paths();
    expect(paths).toHaveLength(1);
    expect(paths[0]!.nodes.map((n) => n.id)).toEqual([ids.ada, ids.notes]);
    expect(paths[0]!.edges.map((e) => e.type)).toEqual(['WROTE']);
  });

  it('aggregations: sum/min/max/avg over selectors', () => {
    const people = db.graph().nodes('Person');
    expect(people.sum((n) => n.props.born as number)).toBe(3606);
    expect(people.min((n) => n.props.born as number)).toBe(1791);
    expect(people.max((n) => n.props.born as number)).toBe(1815);
    expect(people.avg((n) => n.props.born as number)).toBe(1803);
    expect(db.graph().nodes('Nope').avg((n) => 1)).toBeUndefined();
  });
});
