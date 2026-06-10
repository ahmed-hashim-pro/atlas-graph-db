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
  private closePromise: Promise<void> | undefined;
  /** Resolves when the currently in-flight flush (if any) has settled. */
  private flushTail: Promise<void> = Promise.resolve();
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
          // Mid-run fsync failures are tolerated in interval mode (it only
          // promises best-effort durability between barriers); the close-time
          // sync below is the authoritative barrier and does propagate errors.
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
      this.scheduleFlush();
    });
  }

  /** Idempotent: concurrent/repeat calls share one close. Appends issued after
   * close() begins are rejected; in-flight groups are drained first. */
  close(): Promise<void> {
    this.closePromise ??= this.doClose();
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    this.closed = true;
    while (this.flushing || this.pending.length > 0) await this.flushTail;
    if (this.timer) clearInterval(this.timer);
    try {
      if (this.mode === 'always') {
        // Every acked append was already fsynced; this barrier is redundant
        // belt-and-braces, so a failure here cannot lose acknowledged data.
        await this.fh.sync().catch(() => undefined);
      } else {
        // In interval mode this is the only durability barrier for appends
        // since the last successful periodic sync — surface failures.
        await this.fh.sync();
      }
    } finally {
      await this.fh.close();
    }
  }

  private scheduleFlush(): void {
    if (this.flushing || this.pending.length === 0) return;
    this.flushing = true;
    this.flushTail = this.flushGroup();
  }

  private async flushGroup(): Promise<void> {
    const group = this.pending;
    this.pending = [];
    try {
      const buf = group.length === 1 ? group[0]!.frame : Buffer.concat(group.map((g) => g.frame));
      let written = 0;
      while (written < buf.length) {
        const { bytesWritten } = await this.fh.write(buf, written, buf.length - written);
        if (bytesWritten <= 0) throw new Error(`WAL short write: ${written}/${buf.length} bytes`);
        written += bytesWritten;
      }
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
      this.scheduleFlush();
    }
  }
}
