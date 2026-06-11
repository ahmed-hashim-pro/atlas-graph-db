import { encode } from '@msgpack/msgpack';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';
import { snapshotPath } from '../src/files.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-ixp-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const DEF = { kind: 'property', label: 'Person', property: 'born' } as const;

describe('index persistence', () => {
  it('recovers definitions and postings from WAL alone', async () => {
    const db = await openDatabase(dir);
    await db.createIndex(DEF);
    let id!: number;
    await db.transact((tx) => void (id = tx.createNode(['Person'], { born: 1815 })));
    await db.close();
    const db2 = await openDatabase(dir);
    expect(db2.listIndexes()).toEqual([DEF]);
    expect([...db2.lookupRange('Person', 'born', { gte: 1800 })]).toHaveLength(1);
    expect(db2.lookupExact('Person', 'born', 1815)).toEqual(new Set([id]));
    await db2.close();
  });

  it('recovers definitions through a snapshot, backfilled over snapshot nodes', async () => {
    const db = await openDatabase(dir);
    await db.transact((tx) => void tx.createNode(['Person'], { born: 1791 }));
    await db.createIndex(DEF);
    await db.checkpoint();
    await db.transact((tx) => void tx.createNode(['Person'], { born: 1867 }));
    await db.close();
    const db2 = await openDatabase(dir);
    expect(db2.listIndexes()).toEqual([DEF]);
    expect([...db2.lookupRange('Person', 'born', {})]).toHaveLength(2);
    await db2.close();
  });

  it('dropIndex persists too', async () => {
    const db = await openDatabase(dir);
    await db.createIndex(DEF);
    await db.dropIndex(DEF);
    await db.close();
    const db2 = await openDatabase(dir);
    expect(db2.listIndexes()).toEqual([]);
    await db2.close();
  });

  it('createIndex in the post-snapshot WAL tail backfills over snapshot-loaded nodes', async () => {
    const db = await openDatabase(dir);
    let id!: number;
    await db.transact((tx) => void (id = tx.createNode(['Person'], { born: 1815 })));
    await db.checkpoint();
    await db.createIndex(DEF); // committed after the snapshot, replayed from the WAL tail
    await db.close();
    const db2 = await openDatabase(dir);
    expect(db2.listIndexes()).toEqual([DEF]);
    expect(db2.lookupExact('Person', 'born', 1815)).toEqual(new Set([id]));
    await db2.close();
  });

  it('searchText delegates at the db level and survives reopen', async () => {
    const FT = { kind: 'fulltext', label: 'Person', property: 'bio' } as const;
    const db = await openDatabase(dir);
    await db.createIndex(FT);
    let id!: number;
    await db.transact(
      (tx) => void (id = tx.createNode(['Person'], { bio: 'pioneer of analytical engines' })),
    );
    expect(db.searchText('Person', 'bio', 'analytical')).toEqual(new Set([id]));
    expect(db.searchText('Person', 'born', 'analytical')).toBeUndefined();
    await db.close();
    const db2 = await openDatabase(dir);
    expect(db2.searchText('Person', 'bio', 'engin', { prefix: true })).toEqual(new Set([id]));
    await db2.close();
  });

  it('opens pre-M2 snapshots that lack the indexes field', async () => {
    // Hand-craft a legacy snapshot: MAGIC + msgpack of a SnapshotData literal
    // written before the `indexes` key existed.
    const legacy = {
      lastTxId: 1,
      nextNodeId: 2,
      nextEdgeId: 1,
      nodes: [{ id: 1, labels: ['Person'], props: { born: 1815 } }],
      edges: [],
    };
    await writeFile(snapshotPath(dir, 0), Buffer.concat([Buffer.from('ATLS1'), encode(legacy)]));
    const db = await openDatabase(dir);
    expect(db.listIndexes()).toEqual([]);
    expect(db.getNode(1)).toEqual({ id: 1, labels: ['Person'], props: { born: 1815 } });
    await db.close();
  });
});
