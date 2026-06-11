import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-db-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('AtlasDatabase', () => {
  it('commits atomically and reads see committed state', async () => {
    const db = await openDatabase(dir);
    let ada = 0;
    const { txId } = await db.transact((tx) => {
      ada = tx.createNode(['Person'], { name: 'Ada' });
      const doc = tx.createNode(['Document'], { title: 'Notes' });
      tx.createEdge('WROTE', ada, doc);
    });
    expect(txId).toBe(1);
    expect(db.getNode(ada)?.props.name).toBe('Ada');
    expect(db.outEdges(ada, 'WROTE')).toHaveLength(1);
    expect(db.stats()).toEqual({ nodeCount: 2, edgeCount: 1 });
    await db.close();
  });

  it('rolls back on user error: nothing applied, nothing persisted', async () => {
    const db = await openDatabase(dir);
    await expect(
      db.transact((tx) => {
        tx.createNode(['Person'], { name: 'ghost' });
        throw new Error('user abort');
      }),
    ).rejects.toThrow('user abort');
    expect(db.stats()).toEqual({ nodeCount: 0, edgeCount: 0 });
    await db.close();
    const db2 = await openDatabase(dir);
    expect(db2.stats()).toEqual({ nodeCount: 0, edgeCount: 0 });
    await db2.close();
  });

  it('recovers committed state across reopen, ids never reused', async () => {
    const db = await openDatabase(dir);
    let first = 0;
    await db.transact((tx) => {
      first = tx.createNode(['A'], {});
    });
    await db.transact((tx) => tx.deleteNode(first));
    await db.close();

    const db2 = await openDatabase(dir);
    expect(db2.stats().nodeCount).toBe(0);
    let second = 0;
    await db2.transact((tx) => {
      second = tx.createNode(['A'], {});
    });
    expect(second).toBeGreaterThan(first);
    await db2.close();
  });

  it('serializes concurrent transactions', async () => {
    const db = await openDatabase(dir);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => db.transact((tx) => void tx.createNode(['N'], {}))),
    );
    expect(results.map((r) => r.txId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(db.stats().nodeCount).toBe(10);
    await db.close();
  });

  it('truncates a torn WAL tail on reopen and keeps prior commits', async () => {
    const db = await openDatabase(dir);
    await db.transact((tx) => void tx.createNode(['A'], {}));
    await db.close();
    const { appendFile } = await import('node:fs/promises');
    const { walPath } = await import('../src/files.js');
    await appendFile(walPath(dir, 1), Buffer.from([9, 9, 9]));
    const db2 = await openDatabase(dir);
    expect(db2.stats().nodeCount).toBe(1);
    await db2.transact((tx) => void tx.createNode(['A'], {}));
    expect(db2.stats().nodeCount).toBe(2);
    await db2.close();
  });
});
