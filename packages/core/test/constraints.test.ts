import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';
import { AtlasError } from '../src/errors.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-uniq-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const UNIQ = { kind: 'unique', label: 'Person', property: 'email' } as const;

describe('unique constraints', () => {
  it('rejects committed duplicates and rolls back the whole batch', async () => {
    const db = await openDatabase(dir);
    await db.transact((tx) => {
      tx.createIndex(UNIQ);
      tx.createNode(['Person'], { email: 'ada@example.com' });
    });
    await expect(
      db.transact((tx) => {
        tx.createNode(['Person'], { name: 'innocent bystander' });
        tx.createNode(['Person'], { email: 'ada@example.com' });
      }),
    ).rejects.toMatchObject({ code: 'CONSTRAINT_VIOLATION' });
    expect(db.stats().nodeCount).toBe(1); // bystander rolled back too
    await db.close();
  });

  it('rejects duplicates within a single batch', async () => {
    const db = await openDatabase(dir);
    await db.transact((tx) => tx.createIndex(UNIQ));
    await expect(
      db.transact((tx) => {
        tx.createNode(['Person'], { email: 'x@x' });
        tx.createNode(['Person'], { email: 'x@x' });
      }),
    ).rejects.toMatchObject({ code: 'CONSTRAINT_VIOLATION' });
    await db.close();
  });

  it('allows a value to move between nodes in one batch', async () => {
    const db = await openDatabase(dir);
    let a = 0;
    await db.transact((tx) => {
      tx.createIndex(UNIQ);
      a = tx.createNode(['Person'], { email: 'shared@x' });
    });
    await db.transact((tx) => {
      tx.setNodeProps(a, { email: 'new@x' });
      tx.createNode(['Person'], { email: 'shared@x' }); // old value freed earlier in batch
    });
    expect(db.stats().nodeCount).toBe(2);
    await db.close();
  });

  it('rejects creating a constraint over existing duplicate data', async () => {
    const db = await openDatabase(dir);
    await db.transact((tx) => {
      tx.createNode(['Person'], { email: 'dup@x' });
      tx.createNode(['Person'], { email: 'dup@x' });
    });
    await expect(db.transact((tx) => tx.createIndex(UNIQ))).rejects.toMatchObject({
      code: 'CONSTRAINT_VIOLATION',
    });
    expect(db.listIndexes()).toEqual([]); // nothing half-created
    await db.close();
  });

  it('does not conflate equal-looking values of different types', async () => {
    const db = await openDatabase(dir);
    await db.transact((tx) => tx.createIndex({ kind: 'unique', label: 'P', property: 'v' }));
    await db.transact((tx) => {
      tx.createNode(['P'], { v: 1 });
      tx.createNode(['P'], { v: '1' });
    });
    expect(db.stats().nodeCount).toBe(2);
    await db.close();
  });
});
