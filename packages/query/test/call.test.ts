import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '@atlas/core';
import { AqlError } from '../src/errors.js';
import { parseQuery } from '../src/parser.js';
import { runCall } from '../src/call.js';

let dir: string;
let db: AtlasDatabase;
let n: number[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-call-'));
  db = await openDatabase(dir);
  n = [];
  await db.transact((tx) => {
    n = Array.from({ length: 3 }, () => tx.createNode(['V'], {}));
    tx.createEdge('R', n[0]!, n[1]!);
    tx.createEdge('R', n[1]!, n[2]!);
    tx.createEdge('R', n[2]!, n[0]!);
  });
});
afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

function call(src: string) {
  const p = parseQuery(src);
  if (p.statement.type !== 'call') throw new Error(`expected call, got ${p.statement.type}`);
  return p.statement.statement;
}

describe('CALL parsing', () => {
  it('parses namespaced name, args, and YIELD with aliases', () => {
    const c = call('CALL algo.pagerank({damping: 0.85}) YIELD node, score');
    expect(c.name).toBe('algo.pagerank');
    expect(c.yields).toEqual([{ name: 'node' }, { name: 'score' }]);
    const c2 = call('CALL algo.shortestPath({from: $a, to: $b}) YIELD path AS p, cost');
    expect(c2.yields[0]).toEqual({ name: 'path', alias: 'p' });
  });

  it('rejects unknown algorithms and bad YIELD columns at execution', async () => {
    await expect(runCall(call('CALL algo.nope() YIELD x'), db, {})).rejects.toThrowError(AqlError);
  });
});

describe('CALL execution maps onto db.algo', () => {
  it('pagerank yields node + score for every node', async () => {
    const r = await runCall(call('CALL algo.pagerank() YIELD node, score'), db, {});
    expect(r.columns).toEqual(['node', 'score']);
    expect(r.rows).toHaveLength(3);
    expect(r.rows.reduce((s, row) => s + (row[1] as number), 0)).toBeCloseTo(1, 6);
  });

  it('shortestPath takes params and yields path + cost', async () => {
    const r = await runCall(
      call('CALL algo.shortestPath({from: $a, to: $b}) YIELD path AS p, cost'),
      db,
      { a: n[0], b: n[2] },
    );
    expect(r.columns).toEqual(['p', 'cost']);
    expect(r.rows[0]![1]).toBe(2); // a->b->c
  });

  it('components mode argument flows through', async () => {
    const r = await runCall(
      call("CALL algo.components({mode: 'strong'}) YIELD node, component"),
      db,
      {},
    );
    expect(r.rows).toHaveLength(3);
    expect(new Set(r.rows.map((row) => row[1])).size).toBe(1); // one SCC (the 3-cycle)
  });

  it('YIELD selects/renames a subset of result columns', async () => {
    const r = await runCall(call('CALL algo.degree() YIELD node'), db, {});
    expect(r.columns).toEqual(['node']);
    expect(r.rows[0]).toHaveLength(1);
  });
});

describe('CALL YIELD validation uses the static algorithm schema', () => {
  it("rejects a typo'd YIELD even when the result set is empty", async () => {
    // A fresh acyclic 2-node graph → algo.cycles returns ZERO rows, but "cyc"
    // is still an invalid column for algo.cycles (valid: cycle).
    const d2 = await mkdtemp(join(tmpdir(), 'atlas-call-empty-'));
    const db2 = await openDatabase(d2);
    await db2.transact((tx) => {
      const a = tx.createNode(['V'], {});
      const b = tx.createNode(['V'], {});
      tx.createEdge('R', a, b); // acyclic → no cycles
    });
    await expect(
      runCall(call('CALL algo.cycles() YIELD cyc'), db2, {}),
    ).rejects.toMatchObject({ code: 'SEMANTIC_ERROR' });
    // A valid YIELD on the same empty result returns the column with no rows.
    const ok = await runCall(call('CALL algo.cycles() YIELD cycle'), db2, {});
    expect(ok.columns).toEqual(['cycle']);
    expect(ok.rows).toEqual([]);
    await db2.close();
    await rm(d2, { recursive: true, force: true });
  });

  it("still rejects a typo'd YIELD on a non-empty result (regression)", async () => {
    // The shared 3-cycle db has nodes, so algo.degree returns rows; "scor" is invalid.
    await expect(
      runCall(call('CALL algo.degree() YIELD node, scor'), db, {}),
    ).rejects.toMatchObject({ code: 'SEMANTIC_ERROR' });
  });
});
