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
let n: Record<string, number>;

// Chain a->b->c->d (REL), plus c->a closing a cycle, plus disjoint x->y (OTHER).
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-execp-'));
  db = await openDatabase(dir);
  n = {};
  await db.transact((tx) => {
    for (const k of ['a', 'b', 'c', 'd', 'x', 'y']) n[k] = tx.createNode(['V'], { k });
    tx.createEdge('REL', n.a!, n.b!);
    tx.createEdge('REL', n.b!, n.c!);
    tx.createEdge('REL', n.c!, n.d!);
    tx.createEdge('REL', n.c!, n.a!);
    tx.createEdge('OTHER', n.x!, n.y!);
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

describe('variable-length expansion', () => {
  it('*1..2 yields one row per edge-unique path', () => {
    const r = run(`MATCH (s:V {k: 'a'})-[:REL*1..2]->(t) RETURN t.k ORDER BY t.k`);
    expect(r.rows.map((row) => row[0])).toEqual(['b', 'c']); // a->b, a->b->c
  });

  it('min bound excludes shorter paths; cycles do not loop forever (edge-unique)', () => {
    const r = run(`MATCH (s:V {k: 'a'})-[:REL*3..4]->(t) RETURN t.k ORDER BY t.k`);
    // a->b->c->d (len 3), a->b->c->a (len 3, returns to start) — edge-uniqueness ends there.
    expect(r.rows.map((row) => row[0])).toEqual(['a', 'd']);
  });

  it('bound endpoints filter paths: cycle detection via shared variable', () => {
    const r = run(`MATCH (s:V {k: 'a'})-[:REL*1..4]->(s) RETURN count(*)`);
    expect(r.rows).toEqual([[1]]); // exactly the a->b->c->a cycle
  });
});

describe('multi-pattern joins', () => {
  it('shared variables continue the stream (no cartesian blowup)', () => {
    const r = run(`MATCH (s:V {k: 'a'})-[:REL]->(m), (m)-[:REL]->(t) RETURN t.k`);
    expect(r.rows).toEqual([['c']]);
  });

  it('disjoint patterns produce the full cartesian product', () => {
    const r = run(`MATCH (p:V {k: 'a'}), (q:V {k: 'x'})-[:OTHER]->(z) RETURN p.k, z.k`);
    expect(r.rows).toEqual([['a', 'y']]);
  });

  it('repeated node variable inside one pattern must re-match the same node', () => {
    // Anchor the start node `(s:V {k:'a'})` so the planner emits an IndexSeek
    // from the single node `a` (orchestrator decision: option (b) of the Task 8
    // review). The closing -[:REL]->(s) must re-bind that same anchored start,
    // so the single directed 3-cycle a->b->c->a yields exactly one binding.
    const r = run(`MATCH (s:V {k: 'a'})-[:REL]->(m)-[:REL]->(e)-[:REL]->(s) RETURN s.k, m.k, e.k`);
    expect(r.rows).toEqual([['a', 'b', 'c']]); // the only 3-cycle
  });
});
