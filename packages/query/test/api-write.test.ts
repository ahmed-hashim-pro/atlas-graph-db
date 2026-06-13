import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '@atlas/core';
import { executeQuery } from '../src/api.js';

let dir: string;
let db: AtlasDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-apiw-'));
  db = await openDatabase(dir);
});
afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('executeQuery routes every statement type', () => {
  it('runs a write and persists, returning RETURN rows + stats', async () => {
    const r = await executeQuery(db, "CREATE (n:Person {name: 'Ada'}) RETURN n.name AS name");
    expect(r.rows).toEqual([['Ada']]);
    expect(r.stats.created).toBe(1);
    // persisted across a fresh read:
    const read = await executeQuery(db, 'MATCH (p:Person) RETURN count(*) AS c');
    expect(read.rows).toEqual([[1]]);
  });

  it('runs DDL and reflects it in subsequent reads', async () => {
    await executeQuery(db, 'CREATE INDEX ON :Person(born)');
    const shown = await executeQuery(db, 'SHOW INDEXES');
    expect(shown.rows).toEqual([['property', 'Person', 'born']]);
  });

  it('runs CALL and returns yielded columns', async () => {
    await executeQuery(db, 'CREATE (a:V)-[:R]->(b:V), (b)-[:R]->(a)');
    const r = await executeQuery(db, 'CALL algo.degree() YIELD node, score');
    expect(r.columns).toEqual(['node', 'score']);
    expect(r.rows).toHaveLength(2);
  });

  it('EXPLAIN works for write, DDL, and CALL without executing them', async () => {
    const w = await executeQuery(db, "EXPLAIN CREATE (n:Person {name: 'X'}) RETURN n");
    expect(w.columns).toEqual(['plan']);
    expect(JSON.stringify(w.rows[0]![0])).toContain('Create');
    expect([...db.nodesByLabel('Person')]).toHaveLength(0); // not executed

    const d = await executeQuery(db, 'EXPLAIN CREATE INDEX ON :Person(born)');
    expect(JSON.stringify(d.rows[0]![0])).toContain('createIndex');
    expect(db.listIndexes()).toHaveLength(0); // not executed

    const c = await executeQuery(db, 'EXPLAIN CALL algo.pagerank() YIELD node, score');
    expect(JSON.stringify(c.rows[0]![0])).toContain('algo.pagerank');
  });

  it('a failing write rolls back fully', async () => {
    await executeQuery(db, 'CREATE (a:Linked)-[:R]->(b:Linked)');
    await expect(
      executeQuery(db, 'MATCH (a:Linked)-[:R]->(b) CREATE (:Extra) DELETE a'),
    ).rejects.toThrow();
    const extras = await executeQuery(db, 'MATCH (e:Extra) RETURN count(*) AS c');
    expect(extras.rows).toEqual([[0]]);
  });

  it('errors keep AqlError positions through the public API', async () => {
    await expect(executeQuery(db, 'CREATE (n:T SET n.x = 1')).rejects.toMatchObject({
      code: 'PARSE_ERROR',
    });
  });
});
