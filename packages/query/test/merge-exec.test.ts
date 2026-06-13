import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '@atlas/core';
import { parseQuery } from '../src/parser.js';
import { runWrite } from '../src/write.js';

let dir: string;
let db: AtlasDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-merge-'));
  db = await openDatabase(dir);
});
afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

async function exec(src: string, params: Record<string, unknown> = {}) {
  const parsed = parseQuery(src);
  if (parsed.statement.type !== 'write') throw new Error('not a write');
  return db.transact((tx) => {
    runWrite(
      parsed.statement.type === 'write' ? parsed.statement.query : (null as never),
      db.graphStore,
      tx,
      {
        params,
        source: src,
      },
    );
  });
}

describe('MERGE — single node', () => {
  it('creates when absent, matches when present (no duplicate)', async () => {
    await exec("MERGE (p:Person {email: 'a@x'})");
    await exec("MERGE (p:Person {email: 'a@x'})");
    expect([...db.nodesByLabel('Person')]).toHaveLength(1);
    await exec("MERGE (p:Person {email: 'b@x'})");
    expect([...db.nodesByLabel('Person')]).toHaveLength(2);
  });

  it('ON CREATE SET fires only on creation; ON MATCH SET only on match', async () => {
    await exec(
      "MERGE (p:Person {email: 'a@x'}) ON CREATE SET p.created = 1 ON MATCH SET p.seen = 1",
    );
    let p = [...db.nodesByLabel('Person')][0]!;
    expect(p.props).toEqual({ email: 'a@x', created: 1 });
    await exec(
      "MERGE (p:Person {email: 'a@x'}) ON CREATE SET p.created = 2 ON MATCH SET p.seen = 9",
    );
    p = db.getNode(p.id)!;
    expect(p.props).toEqual({ email: 'a@x', created: 1, seen: 9 }); // created untouched, seen added
  });
});

describe('MERGE — whole pattern semantics', () => {
  it('creates the ENTIRE pattern when the full pattern does not match, even if endpoints exist', async () => {
    await exec("CREATE (:Person {name: 'Ada'}), (:Document {title: 'Notes'})");
    // No WROTE edge exists, so the whole pattern fails to match -> create fresh nodes + edge.
    await exec("MERGE (p:Person {name: 'Ada'})-[:WROTE]->(d:Document {title: 'Notes'})");
    expect([...db.nodesByLabel('Person')]).toHaveLength(2); // a NEW Ada was created
    expect([...db.nodesByLabel('Document')]).toHaveLength(2);
  });

  it('matches an existing full pattern without creating', async () => {
    await exec("CREATE (p:Person {name: 'Ada'})-[:WROTE]->(d:Document {title: 'Notes'})");
    await exec("MERGE (p:Person {name: 'Ada'})-[:WROTE]->(d:Document {title: 'Notes'})");
    expect([...db.nodesByLabel('Person')]).toHaveLength(1);
    expect([...db.nodesByLabel('Document')]).toHaveLength(1);
  });

  it('MATCH ... MERGE runs once per row, reusing bound variables', async () => {
    await exec("CREATE (:Person {name: 'A'}), (:Person {name: 'B'})");
    await exec('MATCH (p:Person) MERGE (p)-[:HAS]->(:Profile)');
    expect([...db.nodesByLabel('Profile')]).toHaveLength(2);
    await exec('MATCH (p:Person) MERGE (p)-[:HAS]->(:Profile)'); // idempotent
    expect([...db.nodesByLabel('Profile')]).toHaveLength(2);
  });
});

describe('MERGE — constraint interaction', () => {
  it('a create-path MERGE violating a unique constraint raises CONSTRAINT_VIOLATION', async () => {
    await db.createIndex({ kind: 'unique', label: 'User', property: 'handle' });
    await exec("CREATE (:User {handle: 'ada', extra: 1})");
    // The full pattern {handle:'ada', extra:2} does not match (extra differs in match key? No —
    // MERGE matches on ALL inline props), so it tries to CREATE handle:'ada' -> violation.
    await expect(exec("MERGE (u:User {handle: 'ada', extra: 2})")).rejects.toMatchObject({
      code: 'CONSTRAINT_VIOLATION',
    });
  });
});
