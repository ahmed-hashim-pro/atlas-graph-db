import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase, type NodeRecord } from '@atlas/core';
import { AqlError } from '../src/errors.js';
import { runRead } from '../src/exec.js';
import { parseQuery } from '../src/parser.js';
import { planQuery } from '../src/planner.js';

let dir: string;
let db: AtlasDatabase;
let ids: Record<string, number>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-execb-'));
  db = await openDatabase(dir);
  ids = {};
  await db.transact((tx) => {
    tx.createIndex({ kind: 'property', label: 'Person', property: 'born' });
    ids.ada = tx.createNode(['Person'], { name: 'Ada', born: 1815 });
    ids.charles = tx.createNode(['Person'], { name: 'Charles', born: 1791 });
    ids.marie = tx.createNode(['Person'], { name: 'Marie', born: 1867 });
    ids.notes = tx.createNode(['Document'], { title: 'Notes', year: 1843 });
    ids.sketch = tx.createNode(['Document'], { title: 'Sketch', year: 1842 });
    tx.createEdge('WROTE', ids.ada, ids.notes);
    tx.createEdge('WROTE', ids.charles, ids.sketch);
    tx.createEdge('KNOWS', ids.ada, ids.charles);
  });
});
afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

function run(
  src: string,
  params: Record<string, unknown> = {},
  opts: { maxRows?: number; timeoutMs?: number } = {},
) {
  const { query } = parseQuery(src);
  const plan = planQuery(query, db.graphStore);
  return runRead(plan, query, db.graphStore, {
    params,
    source: src,
    timeoutMs: opts.timeoutMs ?? 10_000,
    maxRows: opts.maxRows ?? 100_000,
  });
}

describe('runRead — basics', () => {
  it('label scan + projection of props and whole nodes', () => {
    const r = run('MATCH (p:Person) RETURN p.name AS name, p ORDER BY name');
    expect(r.columns).toEqual(['name', 'p']);
    expect(r.rows.map((row) => row[0])).toEqual(['Ada', 'Charles', 'Marie']);
    expect((r.rows[0]![1] as NodeRecord).id).toBe(ids.ada);
  });

  it('index seek start with WHERE residual', () => {
    const r = run('MATCH (p:Person {born: 1815}) RETURN p.name');
    expect(r.rows).toEqual([['Ada']]);
    expect(r.stats.rowsExamined).toBeLessThan(4); // seek, not scan
  });

  it('expand with type and direction, inline target props as filters', () => {
    expect(run('MATCH (p:Person)-[:WROTE]->(d:Document {year: 1843}) RETURN p.name').rows).toEqual([
      ['Ada'],
    ]);
    expect(run('MATCH (d:Document)<-[:WROTE]-(p) RETURN d.title ORDER BY d.title').rows).toEqual([
      ['Notes'],
      ['Sketch'],
    ]);
    expect(run('MATCH (a:Person)-[:KNOWS]-(b:Person) RETURN a.name ORDER BY a.name').rows).toEqual([
      ['Ada'],
      ['Charles'],
    ]); // both-direction matches each endpoint once
  });

  it('edge variables bind and project', () => {
    const r = run('MATCH (p)-[w:WROTE]->(d) RETURN type(w), d.title ORDER BY d.title');
    expect(r.rows.map((row) => row[0])).toEqual(['WROTE', 'WROTE']);
  });

  it('WHERE with params; missing label/prop yields empty', () => {
    expect(run('MATCH (p:Person) WHERE p.born > $y RETURN p.name', { y: 1800 }).rows).toHaveLength(
      2,
    );
    expect(run('MATCH (p:Ghost) RETURN p').rows).toEqual([]);
  });

  it('ORDER BY DESC, SKIP, LIMIT with params', () => {
    const r = run('MATCH (p:Person) RETURN p.born ORDER BY p.born DESC SKIP 1 LIMIT $n', { n: 1 });
    expect(r.rows).toEqual([[1815]]);
  });

  it('DISTINCT collapses duplicate rows', () => {
    const r = run('MATCH (p:Person)-[:WROTE|KNOWS]->(x) RETURN DISTINCT p.name ORDER BY p.name');
    expect(r.rows).toEqual([['Ada'], ['Charles']]);
  });

  it('ROW_LIMIT and TIMEOUT guards fire as errors, never truncation', () => {
    expect(() => run('MATCH (p:Person) RETURN p', {}, { maxRows: 2 })).toThrowError(AqlError);
    try {
      run('MATCH (a)-[*1..8]-(b) RETURN count(*)', {}, { timeoutMs: 0 });
      expect.unreachable();
    } catch (e) {
      expect(['TIMEOUT', 'ROW_LIMIT']).toContain((e as AqlError).code);
    }
  });

  it('LIMIT short-circuits before maxRows: small LIMIT under tiny maxRows does not raise ROW_LIMIT', () => {
    // 5 nodes total, maxRows 2, but LIMIT 1 only ever produces one surviving row.
    const r = run('MATCH (n) RETURN n LIMIT 1', {}, { maxRows: 2 });
    expect(r.rows).toHaveLength(1);
  });
});
