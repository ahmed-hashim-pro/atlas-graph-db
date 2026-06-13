import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type AtlasDatabase } from '@atlas/core';
import { loadDataset, scienceHistory } from '@atlas/datasets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeQuery } from '../src/api.js';

let dir: string;
let db: AtlasDatabase;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-e2e-'));
  db = await openDatabase(dir, { fsync: { intervalMs: 1000 } });
  await loadDataset(db, scienceHistory());
});
afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('AQL end-to-end on science-history', () => {
  it('read + write round trip: tag prolific authors, then query the tag', async () => {
    await executeQuery(db, 'CREATE INDEX ON :Person(name)');
    const w = await executeQuery(
      db,
      'MATCH (p:Person)-[:WROTE]->(d:Document) RETURN p.name AS name, count(d) AS works',
    );
    expect(w.rows.length).toBeGreaterThan(0);

    await executeQuery(db, "MATCH (p:Person {name: 'Ada Lovelace'}) SET p.featured = true");
    const featured = await executeQuery(
      db,
      'MATCH (p:Person) WHERE p.featured = true RETURN p.name AS name',
    );
    expect(featured.rows).toEqual([['Ada Lovelace']]);
  });

  it('MERGE is idempotent across repeated runs', async () => {
    const before = (await executeQuery(db, 'MATCH (t:Topic) RETURN count(*) AS c')).rows[0]![0];
    for (let i = 0; i < 3; i++) await executeQuery(db, "MERGE (t:Topic {name: 'Computing'})");
    const after = (await executeQuery(db, 'MATCH (t:Topic) RETURN count(*) AS c')).rows[0]![0];
    expect(after).toBe((before as number) + 1);
  });

  it('CALL pagerank then read top nodes back', async () => {
    const r = await executeQuery(db, 'CALL algo.pagerank() YIELD node, score');
    // science-history starts at 500 nodes; MERGE test above adds 1 Topic node first
    expect(r.rows.length).toBeGreaterThanOrEqual(500);
    expect(r.rows.reduce((s, row) => s + (row[1] as number), 0)).toBeCloseTo(1, 4);
  });

  it('DELETE removes and stays deleted', async () => {
    await executeQuery(db, 'CREATE (:Scratch {id: 1}), (:Scratch {id: 2})');
    await executeQuery(db, 'MATCH (s:Scratch) DELETE s');
    expect((await executeQuery(db, 'MATCH (s:Scratch) RETURN count(*) AS c')).rows).toEqual([[0]]);
  });
});
