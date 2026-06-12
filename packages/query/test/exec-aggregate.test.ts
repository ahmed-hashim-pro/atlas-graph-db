import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '@atlas/core';
import { runRead } from '../src/exec.js';
import { parseQuery } from '../src/parser.js';
import { planQuery } from '../src/planner.js';

let dir: string;
let db: AtlasDatabase;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-execa-'));
  db = await openDatabase(dir);
  await db.transact((tx) => {
    const ada = tx.createNode(['Person'], { name: 'Ada', field: 'math' });
    const em = tx.createNode(['Person'], { name: 'Emmy', field: 'math' });
    const marie = tx.createNode(['Person'], { name: 'Marie', field: 'physics' });
    for (let i = 0; i < 3; i++)
      tx.createEdge('WROTE', ada, tx.createNode(['Doc'], { pages: 10 * (i + 1) }));
    for (let i = 0; i < 2; i++) tx.createEdge('WROTE', em, tx.createNode(['Doc'], { pages: 5 }));
    tx.createEdge('WROTE', marie, tx.createNode(['Doc'], { pages: 100 }));
  });
});
afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

function run(src: string) {
  const { query } = parseQuery(src);
  return runRead(planQuery(query, db.graphStore), query, db.graphStore, {
    params: {},
    source: src,
    timeoutMs: 10_000,
    maxRows: 100_000,
  });
}

describe('aggregation', () => {
  it('implicit grouping by the non-aggregate items (the spec example shape)', () => {
    const r = run(
      'MATCH (p:Person)-[:WROTE]->(d:Doc) RETURN p.name, count(d) AS works ORDER BY works DESC',
    );
    expect(r.columns).toEqual(['p.name', 'works']);
    expect(r.rows).toEqual([
      ['Ada', 3],
      ['Emmy', 2],
      ['Marie', 1],
    ]);
  });

  it('sum/avg/min/max/collect over groups', () => {
    const r = run(
      'MATCH (p:Person)-[:WROTE]->(d:Doc) RETURN p.field AS f, sum(d.pages) AS s, avg(d.pages) AS a, min(d.pages) AS lo, max(d.pages) AS hi ORDER BY f',
    );
    expect(r.rows).toEqual([
      ['math', 70, 14, 5, 30],
      ['physics', 100, 100, 100, 100],
    ]);
    const c = run("MATCH (p:Person {field: 'math'}) RETURN collect(p.name) AS names");
    expect((c.rows[0]![0] as string[]).sort()).toEqual(['Ada', 'Emmy']);
  });

  it('count(*) vs count(x) vs count(DISTINCT x)', () => {
    const r = run(
      'MATCH (p:Person)-[:WROTE]->(d:Doc) RETURN count(*), count(d.pages), count(DISTINCT d.pages)',
    );
    expect(r.rows).toEqual([[6, 6, 5]]); // pages 5 repeats
  });

  it('all-aggregate query over an empty match returns one zero row', () => {
    const r = run("MATCH (p:Person {name: 'Nobody'}) RETURN count(*) AS c, sum(p.born) AS s");
    expect(r.rows).toEqual([[0, 0]]);
  });

  it('grouped query over empty match returns no rows', () => {
    expect(run("MATCH (p:Person {name: 'Nobody'}) RETURN p.name, count(*)").rows).toEqual([]);
  });
});
