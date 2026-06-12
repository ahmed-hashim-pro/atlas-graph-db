import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDataset, scienceHistory } from '@atlas/datasets';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';

describe('science-history into a real database', () => {
  it('loads, traverses, and shows up in the schema', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-scihist-'));
    const db = await openDatabase(dir, { fsync: { intervalMs: 1000 } }); // bulk load: no per-batch fsync
    const graph = scienceHistory();
    await loadDataset(db, graph);
    expect(db.stats().nodeCount).toBe(500);

    const g = db.graph();
    const ada = g
      .nodes('Person')
      .where((p) => p.name === 'Ada Lovelace')
      .first();
    expect(ada).toBeDefined();
    expect(g.node(ada!.id).out('WROTE').count()).toBeGreaterThan(0);

    const schema = db.schema();
    expect(schema.labels.map((l) => l.label)).toEqual(['Concept', 'Document', 'Person', 'Place']);
    expect(schema.edgeTypes.find((t) => t.type === 'WROTE')!.from).toEqual(
      expect.objectContaining({ Person: expect.any(Number) }),
    );
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
});
