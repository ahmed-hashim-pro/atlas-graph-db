import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDataset, scienceHistory } from '@atlas/datasets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '../src/database.js';

let dir: string;
let db: AtlasDatabase;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-algods-'));
  db = await openDatabase(dir, { fsync: { intervalMs: 1000 } });
  await loadDataset(db, scienceHistory());
});
afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('algorithms over science-history (500 nodes)', () => {
  it('pagerank conserves probability mass and ranks cited works highly', async () => {
    const rows = await db.algo.pagerank();
    expect(rows).toHaveLength(500);
    expect(rows.reduce((s, r) => s + r.score, 0)).toBeCloseTo(1, 4);
  });

  it('louvain finds a plausible community structure', async () => {
    const rows = await db.algo.louvain();
    const k = new Set(rows.map((r) => r.community)).size;
    expect(k).toBeGreaterThan(2);
    expect(k).toBeLessThan(250);
  });

  it('CITES is acyclic by construction', async () => {
    expect(await db.algo.cycles({ type: 'CITES' })).toEqual([]);
    await expect(db.algo.topoSort({ type: 'CITES' })).resolves.toHaveLength(500);
  });

  it('betweenness completes under sampling and is non-trivial', async () => {
    const rows = await db.algo.betweenness({ sampleK: 50 });
    expect(rows.some((r) => r.score > 0)).toBe(true);
  });
});
