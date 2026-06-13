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
  dir = await mkdtemp(join(tmpdir(), 'atlas-write-'));
  db = await openDatabase(dir);
});
afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

async function exec(src: string, params: Record<string, unknown> = {}) {
  const parsed = parseQuery(src);
  if (parsed.statement.type !== 'write') throw new Error('not a write');
  const wq = parsed.statement.query;
  return db.transact((tx) => {
    // runWrite returns the post-write bindings; tests assert via the store after commit.
    runWrite(wq, db.graphStore, tx, { params, source: src });
  });
}

describe('CREATE', () => {
  it('creates nodes and edges with properties', async () => {
    await exec(
      "CREATE (a:Person {name: 'Ada', born: 1815}), (a)-[:WROTE]->(d:Document {title: 'Notes'})",
    );
    const people = [...db.nodesByLabel('Person')];
    expect(people).toHaveLength(1);
    expect(people[0]!.props).toMatchObject({ name: 'Ada', born: 1815 });
    expect(db.outEdges(people[0]!.id, 'WROTE')).toHaveLength(1);
  });

  it('MATCH ... CREATE runs once per matched row', async () => {
    await exec("CREATE (:Person {name: 'A'}), (:Person {name: 'B'})");
    await exec('MATCH (p:Person) CREATE (p)-[:HAS]->(:Tag {v: 1})');
    expect([...db.nodesByLabel('Tag')]).toHaveLength(2); // one per person
  });

  it('parameters supply property values', async () => {
    await exec('CREATE (n:T {v: $v})', { v: 42 });
    expect([...db.nodesByLabel('T')][0]!.props.v).toBe(42);
  });
});

describe('SET / REMOVE', () => {
  it('sets and removes node properties on matched rows', async () => {
    await exec("CREATE (:Person {name: 'Ada', tmp: 1})");
    await exec("MATCH (p:Person {name: 'Ada'}) SET p.born = 1815, p.field = $f REMOVE p.tmp", {
      f: 'math',
    });
    const ada = [...db.nodesByLabel('Person')][0]!;
    expect(ada.props).toEqual({ name: 'Ada', born: 1815, field: 'math' });
  });

  it('sets edge properties via a bound edge variable', async () => {
    await exec('CREATE (a:P)-[:R]->(b:P)');
    await exec('MATCH (a:P)-[r:R]->(b:P) SET r.weight = 5');
    const a = [...db.nodesByLabel('P')].find((n) => db.outEdges(n.id, 'R').length > 0)!;
    expect(db.outEdges(a.id, 'R')[0]!.props.weight).toBe(5);
  });
});

describe('DELETE', () => {
  it('DELETE removes an edgeless node; refuses one with edges without DETACH', async () => {
    await exec('CREATE (:Lonely {v: 1})');
    await exec('MATCH (n:Lonely) DELETE n');
    expect([...db.nodesByLabel('Lonely')]).toHaveLength(0);

    await exec('CREATE (a:Linked)-[:R]->(b:Linked)');
    await expect(exec('MATCH (a:Linked)-[:R]->(b) DELETE a')).rejects.toThrow();
  });

  it('DETACH DELETE removes a node and its edges', async () => {
    await exec('CREATE (a:Hub)-[:R]->(b:Leaf), (a)-[:R]->(c:Leaf)');
    await exec('MATCH (a:Hub) DETACH DELETE a');
    expect([...db.nodesByLabel('Hub')]).toHaveLength(0);
    expect([...db.nodesByLabel('Leaf')]).toHaveLength(2); // leaves remain, edges gone
  });

  it('rolls back the whole statement on failure (atomic)', async () => {
    await exec('CREATE (a:Linked)-[:R]->(b:Linked)');
    await expect(exec('MATCH (a:Linked)-[:R]->(b) CREATE (:Extra) DELETE a')).rejects.toThrow();
    expect([...db.nodesByLabel('Extra')]).toHaveLength(0); // the CREATE rolled back too
  });
});

describe('RETURN after write', () => {
  it('projects post-write bindings', async () => {
    const result = await runReturn('CREATE (n:T {v: 7}) RETURN n.v AS v');
    expect(result.rows).toEqual([[7]]);
  });

  async function runReturn(src: string) {
    const parsed = parseQuery(src);
    if (parsed.statement.type !== 'write') throw new Error('not a write');
    const wq = parsed.statement.query;
    let captured: { columns: string[]; rows: unknown[][] } = { columns: [], rows: [] };
    await db.transact((tx) => {
      captured = runWrite(wq, db.graphStore, tx, { params: {}, source: src });
    });
    return captured;
  }
});
