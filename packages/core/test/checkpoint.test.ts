import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-ckpt-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('checkpointing', () => {
  it('writes a snapshot, rotates the WAL, and deletes covered segments', async () => {
    const db = await openDatabase(dir);
    await db.transact((tx) => void tx.createNode(['A'], { n: 1 }));
    await db.checkpoint();
    const files = await readdir(dir);
    expect(files).toContain('snapshot-000001.bin');
    expect(files).toContain('wal-000002.log');
    expect(files).not.toContain('wal-000001.log');
    await db.close();
  });

  it('recovers from snapshot + newer WAL, preserving id counters', async () => {
    const db = await openDatabase(dir);
    let a = 0;
    await db.transact((tx) => {
      a = tx.createNode(['A'], {});
    });
    await db.checkpoint();
    await db.transact((tx) => void tx.createEdge('T', a, a));
    await db.close();

    const db2 = await openDatabase(dir);
    expect(db2.stats()).toEqual({ nodeCount: 1, edgeCount: 1 });
    let b = 0;
    await db2.transact((tx) => {
      b = tx.createNode(['A'], {});
    });
    expect(b).toBeGreaterThan(a);
    await db2.close();
  });

  it('checkpoints automatically once WAL exceeds the threshold', async () => {
    const db = await openDatabase(dir, { snapshotWalBytes: 256 });
    for (let i = 0; i < 30; i++)
      await db.transact((tx) => void tx.createNode(['A'], { filler: 'x'.repeat(40) }));
    await db.close();
    const files = await readdir(dir);
    expect(files.some((f) => f.startsWith('snapshot-'))).toBe(true);
    const db2 = await openDatabase(dir);
    expect(db2.stats().nodeCount).toBe(30);
    await db2.close();
  });

  it('concurrent checkpoint calls coalesce', async () => {
    const db = await openDatabase(dir);
    await db.transact((tx) => void tx.createNode(['A'], {}));
    await Promise.all([db.checkpoint(), db.checkpoint(), db.checkpoint()]);
    const files = await readdir(dir);
    expect(files.filter((f) => f.startsWith('snapshot-'))).toHaveLength(1);
    await db.close();
  });
});
