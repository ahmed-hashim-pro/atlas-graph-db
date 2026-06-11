import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// `\d{6,}`: pad() emits 7+ digits once seq exceeds 999999, and those
// segments must remain scannable on reopen.
const WAL_RE = /^wal-(\d{6,})\.log$/;
const SNAP_RE = /^snapshot-(\d{6,})\.bin$/;

function pad(seq: number): string {
  return String(seq).padStart(6, '0');
}

export function walPath(dir: string, seq: number): string {
  return join(dir, `wal-${pad(seq)}.log`);
}

export function snapshotPath(dir: string, seq: number): string {
  return join(dir, `snapshot-${pad(seq)}.bin`);
}

export interface DataDirState {
  snapshotSeq: number | null;
  walSeqs: number[];
}

export async function scanDataDir(dir: string): Promise<DataDirState> {
  const entries = await readdir(dir);
  const walSeqs: number[] = [];
  let snapshotSeq: number | null = null;
  for (const name of entries) {
    const wal = WAL_RE.exec(name);
    if (wal) walSeqs.push(Number(wal[1]));
    const snap = SNAP_RE.exec(name);
    if (snap) snapshotSeq = Math.max(snapshotSeq ?? -1, Number(snap[1]));
  }
  walSeqs.sort((a, b) => a - b);
  return { snapshotSeq, walSeqs };
}

export async function fsyncFile(path: string): Promise<void> {
  const fh = await open(path, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}
