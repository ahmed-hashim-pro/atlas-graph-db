import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeBatch } from '../src/codec.js';
import { AtlasError } from '../src/errors.js';
import { openDatabase } from '../src/database.js';
import { scanDataDir, walPath } from '../src/files.js';
import { WalWriter } from '../src/wal.js';

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

  it('rejects async transact callbacks before any WAL write or apply', async () => {
    const db = await openDatabase(dir);
    const err = await db
      .transact(async (tx) => {
        tx.createNode(['Person'], { name: 'racer' });
        await Promise.resolve();
        tx.createNode(['Person'], { name: 'phantom' });
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(AtlasError);
    expect((err as AtlasError).code).toBe('VALIDATION');
    expect((err as AtlasError).message).toMatch(/synchronous/);
    expect(db.stats()).toEqual({ nodeCount: 0, edgeCount: 0 });
    await db.close();
    const db2 = await openDatabase(dir);
    expect(db2.stats()).toEqual({ nodeCount: 0, edgeCount: 0 });
    await db2.close();
  });

  it('returns the sentinel txId 0 for empty transactions without consuming txIds', async () => {
    const db = await openDatabase(dir);
    expect(await db.transact(() => undefined)).toEqual({ txId: 0 });
    expect(await db.transact((tx) => void tx.createNode(['A'], {}))).toEqual({ txId: 1 });
    // A no-op after a real commit must not echo that commit's txId.
    expect(await db.transact(() => undefined)).toEqual({ txId: 0 });
    expect(await db.transact((tx) => void tx.createNode(['A'], {}))).toEqual({ txId: 2 });
    await db.close();
  });

  it('scans WAL/snapshot filenames with more than six digits', async () => {
    await writeFile(join(dir, 'wal-1000000.log'), Buffer.alloc(0));
    await writeFile(join(dir, 'wal-000002.log'), Buffer.alloc(0));
    await writeFile(join(dir, 'snapshot-1000000.bin'), Buffer.alloc(0));
    await expect(scanDataDir(dir)).resolves.toEqual({
      snapshotSeq: 1000000,
      walSeqs: [2, 1000000],
    });
  });

  it('rejects WAL replay when txIds are not strictly monotonic', async () => {
    const wal = await WalWriter.open(walPath(dir, 1), 'always');
    await wal.append(
      encodeBatch({ txId: 1, ops: [{ op: 'createNode', id: 1, labels: ['A'], props: {} }] }),
    );
    await wal.append(
      encodeBatch({ txId: 3, ops: [{ op: 'createNode', id: 2, labels: ['A'], props: {} }] }),
    );
    await wal.close();
    await expect(openDatabase(dir)).rejects.toThrow(/expected txId 2 but found 3/);
  });
});
