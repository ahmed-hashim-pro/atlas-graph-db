import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WalWriter, readWal } from '../src/wal.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-walw-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('WalWriter', () => {
  it('persists appended payloads durably (fsync always)', async () => {
    const p = join(dir, 'wal-000001.log');
    const w = await WalWriter.open(p, 'always');
    await w.append(new TextEncoder().encode('one'));
    await w.append(new TextEncoder().encode('two'));
    await w.close();
    const res = await readWal(p);
    expect(res.payloads.map((x) => new TextDecoder().decode(x))).toEqual(['one', 'two']);
  });

  it('group-commits concurrent appends with fewer fsyncs than appends', async () => {
    const p = join(dir, 'wal-000001.log');
    const w = await WalWriter.open(p, 'always');
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => w.append(new TextEncoder().encode(`p${i}`))),
    );
    expect(w.syncCount).toBeGreaterThan(0);
    expect(w.syncCount).toBeLessThan(20);
    await w.close();
    const res = await readWal(p);
    expect(res.payloads).toHaveLength(20);
  });

  it('interval mode resolves appends without awaiting fsync', async () => {
    const p = join(dir, 'wal-000001.log');
    const w = await WalWriter.open(p, { intervalMs: 50 });
    await w.append(new TextEncoder().encode('x'));
    await w.close();
    const res = await readWal(p);
    expect(res.payloads).toHaveLength(1);
  });

  it('tracks bytesWritten across reopen', async () => {
    const p = join(dir, 'wal-000001.log');
    const w1 = await WalWriter.open(p, 'always');
    await w1.append(new Uint8Array(100));
    await w1.close();
    const w2 = await WalWriter.open(p, 'always');
    expect(w2.bytesWritten).toBe(108);
    await w2.close();
  });
});
