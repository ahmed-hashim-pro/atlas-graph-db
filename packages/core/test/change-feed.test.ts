import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
    feed.subscribe((e) => {
      if (e.type === 'batch') got.push(e.txId);
    }, { fromTxId: 2 });
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
});
