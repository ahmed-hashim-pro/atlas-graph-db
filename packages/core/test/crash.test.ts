import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';
import type { GraphStore } from '../src/store.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'crash-writer.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function crashOnce(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-crash-'));
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', FIXTURE, dir], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let acked = 0;
    let buf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      for (const line of buf.split('\n').slice(0, -1)) {
        const m = /^ACK (\d+)$/.exec(line);
        if (m) acked = Math.max(acked, Number(m[1]));
      }
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
    });
    await sleep(400 + Math.floor(Math.random() * 600));
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));

    const db = await openDatabase(dir);
    (db as unknown as { store: GraphStore }).store.checkInvariants();
    const { nodeCount, edgeCount } = db.stats();
    // Every tx creates exactly 2 nodes + 1 edge; recovered state must be whole transactions...
    expect(nodeCount % 2).toBe(0);
    expect(edgeCount).toBe(nodeCount / 2);
    // ...and must include at least everything that was acknowledged durable.
    expect(edgeCount).toBeGreaterThanOrEqual(acked);
    await db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('crash safety', () => {
  it('survives SIGKILL mid-write: acked commits recovered, no partial batches', async () => {
    for (let i = 0; i < 5; i++) await crashOnce();
  }, 60_000);
});
