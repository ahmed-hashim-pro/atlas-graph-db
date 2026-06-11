import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';

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

  it('rejects setNodeProps that takes a value held by a committed, untouched node', async () => {
    const db = await openDatabase(dir);
    let b = 0;
    await db.transact((tx) => {
      tx.createIndex(UNIQ);
      tx.createNode(['Person'], { email: 'taken@x' });
      b = tx.createNode(['Person'], { email: 'other@x' });
    });
    await expect(
      db.transact((tx) => tx.setNodeProps(b, { email: 'taken@x' })),
    ).rejects.toMatchObject({ code: 'CONSTRAINT_VIOLATION' });
    expect(db.getNode(b)?.props).toEqual({ email: 'other@x' }); // rolled back
    await db.close();
  });

  it('removing the property frees the value for another node in a later batch', async () => {
    const db = await openDatabase(dir);
    let a = 0;
    await db.transact((tx) => {
      tx.createIndex(UNIQ);
      a = tx.createNode(['Person'], { email: 'freed@x' });
    });
    await db.transact((tx) => tx.setNodeProps(a, {}, ['email']));
    await db.transact((tx) => tx.createNode(['Person'], { email: 'freed@x' }));
    expect(db.stats().nodeCount).toBe(2);
    await db.close();
  });
});

describe('unique constraints with same-batch DDL', () => {
  it('drop-then-recreate in one batch still rejects a duplicate staged after it', async () => {
    const db = await openDatabase(dir);
    await db.transact((tx) => {
      tx.createIndex(UNIQ);
      tx.createNode(['Person'], { email: 'ada@example.com' });
    });
    await expect(
      db.transact((tx) => {
        tx.dropIndex(UNIQ);
        tx.createIndex(UNIQ);
        tx.createNode(['Person'], { email: 'ada@example.com' });
      }),
    ).rejects.toMatchObject({ code: 'CONSTRAINT_VIOLATION' });
    expect(db.stats().nodeCount).toBe(1);
    expect(db.listIndexes()).toEqual([UNIQ]); // constraint untouched
    await db.close();
    const reopened = await openDatabase(dir); // a violating batch must never become durable
    expect(reopened.stats().nodeCount).toBe(1);
    await reopened.close();
  });

  it('drop-then-recreate after a duplicate staged earlier in the batch rejects before the WAL', async () => {
    const db = await openDatabase(dir);
    await db.transact((tx) => {
      tx.createIndex(UNIQ);
      tx.createNode(['Person'], { email: 'ada@example.com' });
    });
    await expect(
      db.transact((tx) => {
        tx.createNode(['Person'], { email: 'ada@example.com' });
        tx.dropIndex(UNIQ);
        tx.createIndex(UNIQ);
      }),
    ).rejects.toMatchObject({ code: 'CONSTRAINT_VIOLATION' });
    expect(db.stats().nodeCount).toBe(1);
    expect(db.listIndexes()).toEqual([UNIQ]);
    await db.close();
    const reopened = await openDatabase(dir); // must not throw during WAL replay
    expect(reopened.stats().nodeCount).toBe(1);
    await expect(
      reopened.transact((tx) => tx.createNode(['Person'], { email: 'ada@example.com' })),
    ).rejects.toMatchObject({ code: 'CONSTRAINT_VIOLATION' }); // constraint survived
    await reopened.close();
  });

  it('createIndex plus same-batch deletion of a duplicate commits (end-state semantics)', async () => {
    const db = await openDatabase(dir);
    let dup = 0;
    await db.transact((tx) => {
      tx.createNode(['Person'], { email: 'x@x' });
      dup = tx.createNode(['Person'], { email: 'x@x' });
    });
    await db.transact((tx) => {
      tx.createIndex(UNIQ); // staged before the delete, but end state is duplicate-free
      tx.deleteNode(dup);
    });
    expect(db.stats().nodeCount).toBe(1);
    expect(db.listIndexes()).toEqual([UNIQ]);
    await db.close();
    const reopened = await openDatabase(dir); // replay must rebuild cleanly
    expect(reopened.stats().nodeCount).toBe(1);
    await reopened.close();
  });

  it('create-then-drop over duplicate data nets out and commits cleanly', async () => {
    const db = await openDatabase(dir);
    await db.transact((tx) => {
      tx.createNode(['Person'], { email: 'dup@x' });
      tx.createNode(['Person'], { email: 'dup@x' });
    });
    await db.transact((tx) => {
      tx.createIndex(UNIQ);
      tx.dropIndex(UNIQ); // cancels the create — transient constraint never enforced
      tx.createNode(['Person'], { name: 'bystander' });
    });
    expect(db.stats().nodeCount).toBe(3);
    expect(db.listIndexes()).toEqual([]);
    await db.close();
    const reopened = await openDatabase(dir);
    expect(reopened.stats().nodeCount).toBe(3);
    await reopened.close();
  });
});
