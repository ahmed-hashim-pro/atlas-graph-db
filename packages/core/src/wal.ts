import { open, readFile, type FileHandle } from 'node:fs/promises';
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
    if (crc32(payload) >>> 0 !== crc) break;
    payloads.push(payload);
    off += 8 + len;
  }
  return { payloads, validBytes: off, corruptTail: off < data.length };
}

export type FsyncMode = 'always' | { intervalMs: number };

interface PendingAppend {
  frame: Buffer;
  resolve: () => void;
  reject: (err: unknown) => void;
}

export class WalWriter {
  bytesWritten: number;
  syncCount = 0;
  private pending: PendingAppend[] = [];
  private flushing = false;
  private closed = false;
  private timer: NodeJS.Timeout | undefined;

  private constructor(
    private readonly fh: FileHandle,
    private readonly mode: FsyncMode,
    initialSize: number,
  ) {
    this.bytesWritten = initialSize;
    if (typeof mode === 'object') {
      this.timer = setInterval(() => {
        void this.fh
          .sync()
          .then(() => this.syncCount++)
          .catch(() => undefined);
      }, mode.intervalMs);
      this.timer.unref();
    }
  }

  static async open(path: string, mode: FsyncMode): Promise<WalWriter> {
    const fh = await open(path, 'a');
    const { size } = await fh.stat();
    return new WalWriter(fh, mode, size);
  }

  append(payload: Uint8Array): Promise<void> {
    if (this.closed) return Promise.reject(new Error('WalWriter closed'));
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ frame: encodeFrame(payload), resolve, reject });
      void this.flush();
    });
  }

  async close(): Promise<void> {
    while (this.flushing || this.pending.length > 0) await new Promise((r) => setImmediate(r));
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.fh.sync().catch(() => undefined);
    await this.fh.close();
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.pending.length === 0) return;
    this.flushing = true;
    const group = this.pending;
    this.pending = [];
    try {
      const buf = group.length === 1 ? group[0]!.frame : Buffer.concat(group.map((g) => g.frame));
      await this.fh.write(buf);
      this.bytesWritten += buf.length;
      if (this.mode === 'always') {
        await this.fh.sync();
        this.syncCount++;
      }
      for (const g of group) g.resolve();
    } catch (err) {
      for (const g of group) g.reject(err);
    } finally {
      this.flushing = false;
      void this.flush();
    }
  }
}
