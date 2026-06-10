import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WalWriter, readWal } from '../src/wal.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-walw-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/** Structural view of the private FileHandle, for fault injection via spies. */
interface FhInternals {
  write: (
    buf: Uint8Array,
    offset?: number,
    length?: number,
  ) => Promise<{ bytesWritten: number; buffer: Uint8Array }>;
  sync: () => Promise<void>;
}
const handleOf = (w: WalWriter): FhInternals => (w as unknown as { fh: FhInternals }).fh;

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('WalWriter', () => {
  it('persists appended payloads durably (fsync always)', async () => {
    const p = join(dir, 'wal-000001.log');
    const w = await WalWriter.open(p, 'always');
    await w.append(enc('one'));
    await w.append(enc('two'));
    await w.close();
    const res = await readWal(p);
    expect(res.payloads.map(dec)).toEqual(['one', 'two']);
  });

  it('group-commits concurrent appends with fewer fsyncs than appends', async () => {
    const p = join(dir, 'wal-000001.log');
    const w = await WalWriter.open(p, 'always');
    await Promise.all(Array.from({ length: 20 }, (_, i) => w.append(enc(`p${i}`))));
    expect(w.syncCount).toBeGreaterThan(0);
    expect(w.syncCount).toBeLessThan(20);
    await w.close();
    const res = await readWal(p);
    expect(res.payloads).toHaveLength(20);
  });

  it('interval mode resolves appends without awaiting fsync', async () => {
    const p = join(dir, 'wal-000001.log');
    const w = await WalWriter.open(p, { intervalMs: 60_000 });
    await w.append(enc('x'));
    expect(w.syncCount).toBe(0); // append acked with no fsync issued yet
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

  it('rejects every pending append when the underlying write fails', async () => {
    const p = join(dir, 'wal-000001.log');
    const w = await WalWriter.open(p, 'always');
    const spy = vi.spyOn(handleOf(w), 'write').mockRejectedValue(new Error('disk gone'));
    const results = await Promise.allSettled([
      w.append(enc('a')),
      w.append(enc('b')),
      w.append(enc('c')),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(w.bytesWritten).toBe(0);
    spy.mockRestore();
    await w.append(enc('d'));
    await w.close();
    const res = await readWal(p);
    expect(res.payloads.map(dec)).toEqual(['d']);
  });

  it('completes a short write by writing the remainder', async () => {
    const p = join(dir, 'wal-000001.log');
    const w = await WalWriter.open(p, 'always');
    const fh = handleOf(w);
    const realWrite = fh.write.bind(fh);
    const spy = vi.spyOn(fh, 'write').mockImplementationOnce((buf) => realWrite(buf, 0, 3)); // truncate first write to 3 bytes
    await w.append(enc('hello')); // frame is 8 + 5 = 13 bytes
    expect(spy.mock.calls.length).toBeGreaterThan(1);
    expect(w.bytesWritten).toBe(13);
    await w.close();
    const res = await readWal(p);
    expect(res.payloads.map(dec)).toEqual(['hello']);
    expect(res.corruptTail).toBe(false);
  });

  it('rejects an append when a write makes no progress', async () => {
    const p = join(dir, 'wal-000001.log');
    const w = await WalWriter.open(p, 'always');
    vi.spyOn(handleOf(w), 'write').mockImplementation((buf) =>
      Promise.resolve({ bytesWritten: 0, buffer: buf }),
    );
    await expect(w.append(enc('x'))).rejects.toThrow(/short write/);
    expect(w.bytesWritten).toBe(0);
    vi.restoreAllMocks();
    await w.close();
  });

  it('rejects appends after close and memoizes double close', async () => {
    const p = join(dir, 'wal-000001.log');
    const w = await WalWriter.open(p, 'always');
    await w.append(enc('x'));
    const first = w.close();
    await expect(w.append(enc('y'))).rejects.toThrow('WalWriter closed');
    expect(w.close()).toBe(first);
    await first;
    await expect(w.close()).resolves.toBeUndefined();
    const res = await readWal(p);
    expect(res.payloads).toHaveLength(1);
  });

  it('close surfaces a failed fsync in interval mode', async () => {
    const p = join(dir, 'wal-000001.log');
    const w = await WalWriter.open(p, { intervalMs: 60_000 });
    await w.append(enc('x'));
    vi.spyOn(handleOf(w), 'sync').mockRejectedValue(new Error('fsync failed'));
    await expect(w.close()).rejects.toThrow('fsync failed');
  });

  it('close tolerates a failed fsync in always mode (acked data already durable)', async () => {
    const p = join(dir, 'wal-000001.log');
    const w = await WalWriter.open(p, 'always');
    await w.append(enc('x'));
    vi.spyOn(handleOf(w), 'sync').mockRejectedValue(new Error('fsync failed'));
    await expect(w.close()).resolves.toBeUndefined();
    const res = await readWal(p);
    expect(res.payloads).toHaveLength(1);
  });
});
