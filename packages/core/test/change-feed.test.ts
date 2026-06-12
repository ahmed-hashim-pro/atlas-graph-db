import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ChangeFeed, type ChangeEvent } from '../src/change-feed.js';
import { openDatabase } from '../src/database.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('ChangeFeed unit', () => {
  it('delivers batches in order, asynchronously', async () => {
    const feed = new ChangeFeed(8);
    const got: number[] = [];
    feed.subscribe((e) => {
      if (e.type === 'batch') got.push(e.txId);
    });
    feed.emit({ txId: 1, ops: [] });
    feed.emit({ txId: 2, ops: [] });
    expect(got).toEqual([]); // not synchronous
    await tick();
    expect(got).toEqual([1, 2]);
  });

  it('replays from fromTxId within the window', async () => {
    const feed = new ChangeFeed(8);
    feed.emit({ txId: 1, ops: [] });
    feed.emit({ txId: 2, ops: [] });
    feed.emit({ txId: 3, ops: [] });
    const got: number[] = [];
    feed.subscribe(
      (e) => {
        if (e.type === 'batch') got.push(e.txId);
      },
      { fromTxId: 2 },
    );
    await tick();
    expect(got).toEqual([2, 3]);
  });

  it('overflow evicts; lagging subscriber gets resync_required and is closed', async () => {
    const feed = new ChangeFeed(2);
    const events: ChangeEvent[] = [];
    feed.subscribe((e) => events.push(e));
    await tick(); // settle the empty subscription
    // Burst past capacity before the microtask drain runs:
    for (let txId = 1; txId <= 5; txId++) feed.emit({ txId, ops: [] });
    await tick();
    expect(events.some((e) => e.type === 'resync_required')).toBe(true);
    const before = events.length;
    feed.emit({ txId: 6, ops: [] });
    await tick();
    expect(events.length).toBe(before); // closed — no further deliveries
  });

  it('fromTxId older than the window resyncs immediately', async () => {
    const feed = new ChangeFeed(2);
    for (let txId = 1; txId <= 5; txId++) feed.emit({ txId, ops: [] });
    const events: ChangeEvent[] = [];
    feed.subscribe((e) => events.push(e), { fromTxId: 1 });
    await tick();
    expect(events).toEqual([{ type: 'resync_required' }]);
  });

  it('unsubscribe stops delivery', async () => {
    const feed = new ChangeFeed(8);
    const got: number[] = [];
    const unsub = feed.subscribe((e) => {
      if (e.type === 'batch') got.push(e.txId);
    });
    feed.emit({ txId: 1, ops: [] });
    await tick();
    unsub();
    feed.emit({ txId: 2, ops: [] });
    await tick();
    expect(got).toEqual([1]);
  });

  it('a throwing handler closes its subscription without breaking other subscribers', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const feed = new ChangeFeed(8);
      const good: number[] = [];
      let badCalls = 0;
      feed.subscribe(() => {
        badCalls++;
        throw new Error('boom');
      });
      feed.subscribe((e) => {
        if (e.type === 'batch') good.push(e.txId);
      });
      feed.emit({ txId: 1, ops: [] });
      feed.emit({ txId: 2, ops: [] });
      await tick();
      expect(badCalls).toBe(1); // closed on first throw
      expect(good).toEqual([1, 2]); // other subscriber unaffected
      feed.emit({ txId: 3, ops: [] });
      await tick();
      expect(badCalls).toBe(1); // stays closed
      expect(good).toEqual([1, 2, 3]);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('re-entrant emit that evicts the in-flight cursor resyncs instead of throwing', async () => {
    const feed = new ChangeFeed(2);
    const events: ChangeEvent[] = [];
    let reentered = false;
    feed.subscribe((e) => {
      events.push(e);
      if (!reentered) {
        reentered = true;
        // Evict past the in-flight cursor (cursor is now 2; oldest becomes 3).
        for (let txId = 2; txId <= 4; txId++) feed.emit({ txId, ops: [] });
      }
    });
    feed.emit({ txId: 1, ops: [] });
    await tick();
    expect(events[0]).toMatchObject({ type: 'batch', txId: 1 });
    expect(events.some((e) => e.type === 'resync_required')).toBe(true);
  });

  it('closeAll flushes buffered batches, then closes every subscription', async () => {
    const feed = new ChangeFeed(8);
    const events: ChangeEvent[] = [];
    feed.subscribe((e) => events.push(e));
    feed.emit({ txId: 1, ops: [] });
    feed.closeAll(); // synchronous flush + close
    expect(events).toMatchObject([{ type: 'batch', txId: 1 }]);
    feed.emit({ txId: 2, ops: [] });
    await tick();
    expect(events).toHaveLength(1); // closed — no further deliveries
  });
});

describe('database integration', () => {
  it('subscribers observe committed batches with their ops', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-feed-'));
    const db = await openDatabase(dir);
    const events: ChangeEvent[] = [];
    db.subscribe((e) => events.push(e));
    await db.transact((tx) => void tx.createNode(['A'], { hello: 'world' }));
    await tick();
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.type).toBe('batch');
    if (e.type === 'batch') {
      expect(e.txId).toBe(1);
      expect(e.ops[0]).toMatchObject({ op: 'createNode', props: { hello: 'world' } });
    }
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('reopened database seeds the feed from the recovered txId (no spurious resync)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-feed-'));
    const db1 = await openDatabase(dir);
    await db1.transact((tx) => void tx.createNode(['A'], {}));
    await db1.close();

    // Documented recovery protocol: re-read state, subscribe fresh (default cursor).
    const db2 = await openDatabase(dir);
    const events: ChangeEvent[] = [];
    db2.subscribe((e) => events.push(e));
    await db2.transact((tx) => void tx.createNode(['B'], {}));
    await tick();
    expect(events.some((e) => e.type === 'resync_required')).toBe(false);
    expect(events).toMatchObject([{ type: 'batch', txId: 2 }]);

    await db2.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('db.close() flushes buffered batches and closes feed subscriptions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-feed-'));
    const db = await openDatabase(dir);
    const events: ChangeEvent[] = [];
    db.subscribe((e) => events.push(e));
    await db.transact((tx) => void tx.createNode(['A'], {}));
    await db.close(); // no explicit tick: close() itself must flush
    expect(events).toMatchObject([{ type: 'batch', txId: 1 }]);
    await rm(dir, { recursive: true, force: true });
  });
});
