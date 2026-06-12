import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '@atlas/core';
import { parseQuery } from '../src/parser.js';
import { planQuery } from '../src/planner.js';
import { serializePlan, type PlanNode } from '../src/plan.js';

let dir: string;
let db: AtlasDatabase;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-planner-'));
  db = await openDatabase(dir);
  await db.transact((tx) => {
    tx.createIndex({ kind: 'property', label: 'Person', property: 'born' });
    for (let i = 0; i < 20; i++) tx.createNode(['Person'], { born: 1800 + i });
    for (let i = 0; i < 3; i++) tx.createNode(['Document'], { year: 1840 + i });
  });
});
afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

function plan(src: string): PlanNode {
  return planQuery(parseQuery(src).query, db.graphStore);
}

function leftmost(p: PlanNode): PlanNode {
  let n = p;
  for (;;) {
    if ('child' in n && n.child) n = n.child;
    else if (n.op === 'CartesianProduct') n = n.left;
    else return n;
  }
}

describe('planner start selection', () => {
  it('picks IndexSeek for an indexed inline equality', () => {
    expect(leftmost(plan('MATCH (p:Person {born: 1815}) RETURN p'))).toMatchObject({
      op: 'IndexSeek',
      label: 'Person',
      property: 'born',
      estCost: 1,
    });
  });

  it('extracts indexed equalities from top-level WHERE conjuncts', () => {
    expect(
      leftmost(plan('MATCH (p:Person) WHERE p.born = $b AND p.name = $n RETURN p')),
    ).toMatchObject({ op: 'IndexSeek', property: 'born' });
  });

  it('falls back to the cheapest LabelScan, then AllNodesScan', () => {
    expect(leftmost(plan('MATCH (d:Document) RETURN d'))).toMatchObject({
      op: 'LabelScan',
      label: 'Document',
      estCost: 3,
    });
    expect(leftmost(plan('MATCH (x) RETURN x'))).toMatchObject({ op: 'AllNodesScan', estCost: 23 });
  });

  it('starts the cheaper end of a path pattern', () => {
    // Document (3 nodes) is cheaper than Person (20) — expansion must flip to "in".
    const p = plan('MATCH (p:Person)-[:WROTE]->(d:Document) RETURN p');
    expect(leftmost(p)).toMatchObject({ op: 'LabelScan', label: 'Document' });
    const expand = JSON.stringify(serializePlan(p));
    expect(expand).toContain('"direction":"in"');
  });

  it('second pattern sharing a variable splices into the stream; disjoint patterns go cartesian', () => {
    // The FromBound leaf is spliced away during joining — the tell is NO cartesian product.
    const shared = plan('MATCH (p:Person)-[:KNOWS]->(q:Person), (q)-[:WROTE]->(d) RETURN d');
    expect(JSON.stringify(serializePlan(shared))).not.toContain('"op":"CartesianProduct"');
    expect(JSON.stringify(serializePlan(shared))).not.toContain('"op":"FromBound"');
    const disjoint = plan('MATCH (a:Person), (b:Document) RETURN a, b');
    expect(JSON.stringify(serializePlan(disjoint))).toContain('"op":"CartesianProduct"');
  });

  it('EXPLAIN serialization strips Ast fields and is JSON-round-trippable', () => {
    const p = plan(
      'MATCH (p:Person {born: 1815})-[:WROTE*1..2]->(d) WHERE d.year > 1 RETURN p, d LIMIT 5',
    );
    const json = serializePlan(p);
    const text = JSON.stringify(json);
    expect(text).not.toContain('Ast');
    expect(text).toContain('"op":"VarLengthExpand"');
    expect(text).toContain('"op":"SkipLimit"');
    expect(JSON.parse(text)).toEqual(json);
  });
});
