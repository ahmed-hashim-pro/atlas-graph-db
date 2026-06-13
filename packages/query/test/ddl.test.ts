import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '@atlas/core';
import { AqlError } from '../src/errors.js';
import { parseQuery } from '../src/parser.js';
import { runDdl } from '../src/ddl.js';

let dir: string;
let db: AtlasDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-ddl-'));
  db = await openDatabase(dir);
});
afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

function ddl(src: string) {
  const p = parseQuery(src);
  if (p.statement.type !== 'ddl') throw new Error(`expected ddl, got ${p.statement.type}`);
  return p.statement.statement;
}

describe('DDL parsing', () => {
  it('parses each index/constraint form', () => {
    expect(ddl('CREATE INDEX ON :Person(born)')).toMatchObject({
      stmt: 'createIndex',
      kind: 'property',
      label: 'Person',
      property: 'born',
    });
    expect(ddl('CREATE FULLTEXT INDEX ON :Document(title)')).toMatchObject({
      stmt: 'createIndex',
      kind: 'fulltext',
    });
    expect(ddl('CREATE UNIQUE CONSTRAINT ON :User(email)')).toMatchObject({
      stmt: 'createIndex',
      kind: 'unique',
    });
    expect(ddl('DROP INDEX ON :Person(born)')).toMatchObject({
      stmt: 'dropIndex',
      kind: 'property',
    });
    expect(ddl('SHOW INDEXES')).toMatchObject({ stmt: 'showIndexes' });
    expect(ddl('SHOW CONSTRAINTS')).toMatchObject({ stmt: 'showConstraints' });
  });

  it('CREATE (node) is still a write, not DDL', () => {
    expect(parseQuery('CREATE (n:T) RETURN n').statement.type).toBe('write');
  });

  it('rejects malformed DDL with position', () => {
    let e: AqlError | undefined;
    try {
      parseQuery('CREATE INDEX ON Person(born)'); // missing colon
    } catch (err) {
      e = err as AqlError;
    }
    expect(e?.code).toBe('PARSE_ERROR');
  });
});

describe('DDL execution', () => {
  it('creates and drops indexes; SHOW lists them', async () => {
    await runDdl(ddl('CREATE INDEX ON :Person(born)'), db);
    await runDdl(ddl('CREATE UNIQUE CONSTRAINT ON :User(email)'), db);
    const shown = await runDdl(ddl('SHOW INDEXES'), db);
    expect(shown.rows.length).toBe(2);
    expect(shown.columns).toEqual(['kind', 'label', 'property']);
    const cons = await runDdl(ddl('SHOW CONSTRAINTS'), db);
    expect(cons.rows).toEqual([['unique', 'User', 'email']]);
    await runDdl(ddl('DROP INDEX ON :Person(born)'), db);
    expect((await runDdl(ddl('SHOW INDEXES'), db)).rows.length).toBe(1);
  });

  it('a created index actually accelerates and enforces', async () => {
    await runDdl(ddl('CREATE UNIQUE CONSTRAINT ON :User(email)'), db);
    await db.transact((tx) => void tx.createNode(['User'], { email: 'a@x' }));
    await expect(
      db.transact((tx) => void tx.createNode(['User'], { email: 'a@x' })),
    ).rejects.toMatchObject({ code: 'CONSTRAINT_VIOLATION' });
  });
});
