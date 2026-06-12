import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '../src/database.js';

let dir: string;
let db: AtlasDatabase;
let ids: { ada: number; charles: number; notes: number };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-trav2-'));
  db = await openDatabase(dir);
  await db.transact((tx) => {
    tx.createIndex({ kind: 'property', label: 'Person', property: 'born' });
    tx.createIndex({ kind: 'property', label: 'Person', property: 'died' });
    tx.createIndex({ kind: 'fulltext', label: 'Document', property: 'title' });
    const ada = tx.createNode(['Person'], {
      name: 'Ada',
      born: 1815,
      died: new Date('1852-11-27'),
    });
    const charles = tx.createNode(['Person'], {
      name: 'Charles',
      born: 1791,
      died: new Date('1871-10-18'),
    });
    const notes = tx.createNode(['Document'], { title: 'Notes on the Analytical Engine' });
    tx.createEdge('WROTE', ada, notes, { year: 1843 });
    tx.createEdge('KNOWS', ada, charles, { since: 1833 });
    ids = { ada, charles, notes };
  });
});
afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('index-backed sources', () => {
  it('nodesWhere serves exact and range queries from the index', () => {
    const g = db.graph();
    expect(
      g
        .nodesWhere('Person', 'born', 1815)
        .toArray()
        .map((n) => n.id),
    ).toEqual([ids.ada]);
    expect(
      g
        .nodesWhere('Person', 'born', { lt: 1800 })
        .toArray()
        .map((n) => n.id),
    ).toEqual([ids.charles]);
  });

  it('nodesWhere with a Date takes the exact path, not the range path', () => {
    // Both people are in the 'died' index. If the Date branch of the
    // discriminator regressed into lookupRange, the bound-less range would
    // return BOTH ids; the exact path returns only Ada's.
    const g = db.graph();
    expect(
      g
        .nodesWhere('Person', 'died', new Date('1852-11-27'))
        .toArray()
        .map((n) => n.id),
    ).toEqual([ids.ada]);
    expect(g.nodesWhere('Person', 'died', new Date('1900-01-01')).toArray()).toEqual([]);
  });

  it('nodesWhere without an index throws NOT_FOUND (no silent scans)', () => {
    const g = db.graph();
    expect(() => g.nodesWhere('Person', 'name', 'Ada').toArray()).toThrowError(
      /no property index on Person\.name/,
    );
    // range branch: registry-thrown NOT_FOUND, same message
    expect(() => g.nodesWhere('Person', 'name', { lt: 'Z' }).toArray()).toThrowError(
      /no property index on Person\.name/,
    );
  });

  it('search() rides the fulltext index, prefix mode included', () => {
    const g = db.graph();
    expect(
      g
        .search('Document', 'title', 'analytical engine')
        .toArray()
        .map((n) => n.id),
    ).toEqual([ids.notes]);
    expect(g.search('Document', 'title', 'anal', { prefix: true }).count()).toBe(1);
    expect(() => g.search('Document', 'nope', 'x').toArray()).toThrowError(
      /no fulltext index on Document\.nope/,
    );
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
    expect(
      db
        .graph()
        .nodes('Nope')
        .avg(() => 1),
    ).toBeUndefined();
  });
});
