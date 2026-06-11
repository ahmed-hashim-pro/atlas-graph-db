import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';

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
    await db.transact((tx) => void tx.createNode(['Person'], { born: 1815 }));
    await db.close();
    const db2 = await openDatabase(dir);
    expect(db2.listIndexes()).toEqual([DEF]);
    expect([...db2.lookupRange('Person', 'born', { gte: 1800 })]).toHaveLength(1);
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
});
