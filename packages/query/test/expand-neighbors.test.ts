import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type AtlasDatabase } from '@atlas/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeQuery } from '../src/api.js';
// Import the REAL builder/parser the Explorer uses, so this locks in that the
// exact query string + (coerced) params the app sends actually fetch neighbors
// against the engine — not a hand-copied query. `expand.ts`'s only runtime
// dependency is `./graph-model` (its `@atlas/protocol` import is type-only and
// erased), so importing it from this Node-environment package resolves cleanly.
import { neighborQuery, parseGraphRows } from '../../../apps/web/src/app/workspace/expand.js';

// `executeQuery`'s `QueryResult` is structurally identical to the `QueryResponse`
// that `parseGraphRows` consumes (same columns/rows/stats shape), so its return
// value is passed straight through with no cast.

let dir: string;
let db: AtlasDatabase;
let centerId = -1;
let bobId = -1;
let cyId = -1;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-expand-'));
  db = await openDatabase(dir, { fsync: { intervalMs: 1000 } });
  await db.transact((tx) => {
    const a = tx.createNode(['Person'], { name: 'Ada' });
    const b = tx.createNode(['Person'], { name: 'Bob' });
    const c = tx.createNode(['Person'], { name: 'Cy' });
    tx.createEdge('KNOWS', a, b, {});
    tx.createEdge('KNOWS', a, c, {});
    centerId = a;
    bobId = b;
    cyId = c;
  });
});
afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('expand-neighbors against the real engine', () => {
  it('neighborQuery output fetches the centre node and its neighbors for a real (stringified) id', async () => {
    // The id round-trips through the store/UI as a string, exactly as the
    // Inspector emits it. This is the case that returned ZERO rows before the
    // numeric-coercion fix.
    const { query, params } = neighborQuery(String(centerId), 50, 0);
    const res = await executeQuery(db, query, { params });
    expect(res.rows.length).toBe(2);

    const data = parseGraphRows(res);
    expect(data.nodes.map((n) => n.id).sort()).toEqual([centerId, bobId, cyId].map(String).sort());
    expect(data.edges.length).toBe(2);
    expect(data.nodes.find((n) => n.id === String(bobId))?.props['name']).toBe('Bob');
    for (const e of data.edges) {
      expect(e.type).toBe('KNOWS');
      expect(e.from).toBe(String(centerId));
    }
  });

  it('paging via SKIP/LIMIT returns disjoint neighbor pages', async () => {
    const page1 = neighborQuery(String(centerId), 1, 0);
    const page2 = neighborQuery(String(centerId), 1, 1);
    const r1 = await executeQuery(db, page1.query, { params: page1.params });
    const r2 = await executeQuery(db, page2.query, { params: page2.params });
    expect(r1.rows.length).toBe(1);
    expect(r2.rows.length).toBe(1);
    const neighborId = (r: typeof r1): string => {
      const data = parseGraphRows(r);
      const ids = data.nodes.map((n) => n.id).filter((id) => id !== String(centerId));
      return ids[0]!;
    };
    expect(neighborId(r1)).not.toBe(neighborId(r2));
  });

  it('a missing node id yields no neighbors (no throw)', async () => {
    const { query, params } = neighborQuery('999999', 50, 0);
    const res = await executeQuery(db, query, { params });
    expect(res.rows).toEqual([]);
    expect(parseGraphRows(res)).toEqual({ nodes: [], edges: [] });
  });
});
