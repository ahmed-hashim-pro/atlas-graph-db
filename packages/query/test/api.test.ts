import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '@atlas/core';
import { loadDataset, scienceHistory } from '@atlas/datasets';
import { executeQuery, explainQuery } from '../src/api.js';
import { AqlError } from '../src/errors.js';

let dir: string;
let db: AtlasDatabase;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-api-'));
  db = await openDatabase(dir, { fsync: { intervalMs: 1000 } });
  await loadDataset(db, scienceHistory());
  await db.createIndex({ kind: 'property', label: 'Person', property: 'name' });
});
afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('executeQuery over science-history', () => {
  it('runs the spec headline query shape', async () => {
    const r = await executeQuery(
      db,
      'MATCH (p:Person)-[:WROTE]->(d:Document)\nWHERE d.year > 1840\nRETURN p.name, count(d) AS works\nORDER BY works DESC LIMIT 5',
    );
    expect(r.columns).toEqual(['p.name', 'works']);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.length).toBeLessThanOrEqual(5);
    const counts = r.rows.map((row) => row[1] as number);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts); // descending
    expect(r.stats.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('uses the index for parameterized name lookups', async () => {
    const r = await executeQuery(db, 'MATCH (p:Person {name: $who}) RETURN p.born', {
      params: { who: 'Ada Lovelace' },
    });
    expect(r.rows).toEqual([[1815]]);
    expect(r.stats.rowsExamined).toBeLessThan(5);
  });

  it('variable-length CITES reaches concepts transitively', async () => {
    const r = await executeQuery(
      db,
      'MATCH (d:Document)-[:CITES*1..2]->(c:Concept) WHERE d.year < 1850 RETURN count(*) AS n',
    );
    expect(r.rows[0]![0] as number).toBeGreaterThan(0);
  });

  it('EXPLAIN prefix returns the plan instead of rows', async () => {
    const r = await executeQuery(db, "EXPLAIN MATCH (p:Person {name: 'Ada Lovelace'}) RETURN p");
    expect(r.columns).toEqual(['plan']);
    const plan = JSON.stringify(r.rows[0]![0]);
    expect(plan).toContain('"op":"IndexSeek"');
    expect(plan).not.toContain('Ast');
  });

  it('explainQuery helper works with or without the EXPLAIN keyword', () => {
    const a = explainQuery(db, 'MATCH (p:Person) RETURN p');
    const b = explainQuery(db, 'EXPLAIN MATCH (p:Person) RETURN p');
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toContain('"op":"LabelScan"');
  });

  it('errors carry position + snippet through the public API', async () => {
    try {
      await executeQuery(db, 'MATCH (p:Person RETURN p');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AqlError);
      const err = e as AqlError;
      expect(err.code).toBe('PARSE_ERROR');
      expect(err.snippet).toContain('^');
    }
    await expect(
      executeQuery(db, 'MATCH (p:Person) RETURN p', { maxRows: 3 }),
    ).rejects.toMatchObject({ code: 'ROW_LIMIT' });
  });
});
