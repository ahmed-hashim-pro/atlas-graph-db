import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-lease-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('read leases', () => {
  it('holds writes until released; reads still work during the lease', async () => {
    const db = await openDatabase(dir);
    await db.transact((tx) => void tx.createNode(['A'], {}));
    const lease = await db.acquireReadLease();
    let committed = false;
    const write = db
      .transact((tx) => void tx.createNode(['A'], {}))
      .then(() => {
        committed = true;
      });
    await sleep(30);
    expect(committed).toBe(false); // write is buffered behind the lease
    expect(db.stats().nodeCount).toBe(1); // reads unaffected
    lease.release();
    await write;
    expect(committed).toBe(true);
    expect(db.stats().nodeCount).toBe(2);
    await db.close();
  });

  it('expires at the budget, marking the lease and letting writes through', async () => {
    const db = await openDatabase(dir);
    const lease = await db.acquireReadLease({ budgetMs: 40 });
    expect(lease.expired).toBe(false);
    await db.transact((tx) => void tx.createNode(['A'], {})); // resolves once budget expires
    expect(lease.expired).toBe(true);
    lease.release(); // releasing after expiry is a harmless no-op
    await db.close();
  });

  it('double release is a no-op and leases queue fairly with writes', async () => {
    const db = await openDatabase(dir);
    const l1 = await db.acquireReadLease();
    const order: string[] = [];
    const w = db.transact(() => void order.push('write'));
    const l2p = db.acquireReadLease().then((l) => {
      order.push('lease2');
      return l;
    });
    l1.release();
    l1.release();
    await w;
    const l2 = await l2p;
    expect(order).toEqual(['write', 'lease2']); // FIFO through the write queue
    l2.release();
    await db.close();
  });
});
