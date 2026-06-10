import { readFile } from 'node:fs/promises';
import { crc32 } from 'node:zlib';

export function encodeFrame(payload: Uint8Array): Buffer {
  const frame = Buffer.allocUnsafe(8 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  frame.writeUInt32LE(crc32(payload) >>> 0, 4);
  frame.set(payload, 8);
  return frame;
}

export interface WalReadResult {
  payloads: Uint8Array[];
  validBytes: number;
  corruptTail: boolean;
}

export async function readWal(path: string): Promise<WalReadResult> {
  let data: Buffer;
  try {
    data = await readFile(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      return { payloads: [], validBytes: 0, corruptTail: false };
    throw e;
  }
  const payloads: Uint8Array[] = [];
  let off = 0;
  while (off + 8 <= data.length) {
    const len = data.readUInt32LE(off);
    const crc = data.readUInt32LE(off + 4);
    if (off + 8 + len > data.length) break;
    const payload = data.subarray(off + 8, off + 8 + len);
    if ((crc32(payload) >>> 0) !== crc) break;
    payloads.push(payload);
    off += 8 + len;
  }
  return { payloads, validBytes: off, corruptTail: off < data.length };
}
