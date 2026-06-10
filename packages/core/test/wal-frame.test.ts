import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeFrame, readWal } from '../src/wal.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-wal-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('WAL framing', () => {
  it('reads back appended frames', async () => {
    const p = join(dir, 'wal-000001.log');
    const a = new TextEncoder().encode('alpha');
    const b = new TextEncoder().encode('bravo');
    await writeFile(p, Buffer.concat([encodeFrame(a), encodeFrame(b)]));
    const res = await readWal(p);
    expect(res.payloads.map((x) => new TextDecoder().decode(x))).toEqual(['alpha', 'bravo']);
    expect(res.corruptTail).toBe(false);
  });

  it('stops at a torn final frame and reports validBytes', async () => {
    const p = join(dir, 'wal-000001.log');
    const full = encodeFrame(new TextEncoder().encode('whole'));
    const torn = encodeFrame(new TextEncoder().encode('partial')).subarray(0, 9);
    await writeFile(p, Buffer.concat([full, torn]));
    const res = await readWal(p);
    expect(res.payloads).toHaveLength(1);
    expect(res.validBytes).toBe(full.length);
    expect(res.corruptTail).toBe(true);
  });

  it('stops at a corrupted CRC', async () => {
    const p = join(dir, 'wal-000001.log');
    const frame = encodeFrame(new TextEncoder().encode('data'));
    frame[frame.length - 1] ^= 0xff;
    await writeFile(p, frame);
    const res = await readWal(p);
    expect(res.payloads).toHaveLength(0);
    expect(res.validBytes).toBe(0);
    expect(res.corruptTail).toBe(true);
  });

  it('treats a missing file as empty', async () => {
    const res = await readWal(join(dir, 'nope.log'));
    expect(res).toEqual({ payloads: [], validBytes: 0, corruptTail: false });
  });
});
