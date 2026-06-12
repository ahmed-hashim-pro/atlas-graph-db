import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '../src/database.js';

let dir: string;
let db: AtlasDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-stream-'));
  db = await openDatabase(dir);
  for (let batch = 0; batch < 3; batch++)
    await db.transact((tx) => {
      for (let i = 0; i < 1000; i++) tx.createNode(['N'], { i: batch * 1000 + i });
    });
});
afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('stream()', () => {
  it('yields every node and sees a point-in-time view despite concurrent writes', async () => {
    // Acquire the lease FIRST (await the first element), then start the writer —
    // otherwise the write wins the queue race and the assertion is meaningless.
    const iter = db.graph().nodes('N').stream()[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.done).toBe(false);
    let writeDone = false;
    const writer = db
      .transact((tx) => void tx.createNode(['N'], { i: 9999 }))
      .then(() => {
        writeDone = true;
      });
    const seen: number[] = [(first.value as { id: number }).id];
    for (let r = await iter.next(); !r.done; r = await iter.next()) {
      seen.push((r.value as { id: number }).id);
      if (seen.length === 1500) expect(writeDone).toBe(false); // write buffered behind the lease
    }
    expect(seen).toHaveLength(3000); // the concurrent write is not visible to this stream
    await writer;
    expect(db.stats().nodeCount).toBe(3001);
  });

  it('releases the lease when the consumer breaks early', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of db.graph().nodes('N').stream()) break;
    // If the lease leaked, this transact would block until the default budget.
    const before = Date.now();
    await db.transact((tx) => void tx.createNode(['N'], {}));
    expect(Date.now() - before).toBeLessThan(1000);
  });

  it('aborts with TIMEOUT when the budget expires mid-stream', async () => {
    const slow = db.graph().nodes('N').stream({ budgetMs: 30 });
    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of slow) await new Promise((r) => setTimeout(r, 10));
    }).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
