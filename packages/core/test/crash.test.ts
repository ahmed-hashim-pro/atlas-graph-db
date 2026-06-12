import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'crash-writer.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function crashOnce(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-crash-'));
  let passed = false;
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', FIXTURE, dir], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let acked = 0;
    try {
      let buf = '';
      let onFirstAck = (): void => undefined;
      const firstAck = new Promise<void>((resolve) => {
        onFirstAck = resolve;
      });
      child.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        for (const line of buf.split('\n').slice(0, -1)) {
          const m = /^ACK (\d+)$/.exec(line);
          if (m) {
            acked = Math.max(acked, Number(m[1]));
            onFirstAck();
          }
        }
        buf = buf.slice(buf.lastIndexOf('\n') + 1);
      });
      // Arm the kill only after the first durable commit is acknowledged: a
      // child that dies at startup (tsx loader breakage, fixture path drift,
      // import errors under the child's loader) must fail the test loudly
      // instead of passing vacuously against an empty database.
      const earlyExit = new Promise<never>((_, reject) => {
        child.once('exit', (code, signal) =>
          reject(
            new Error(`crash-writer exited before first ACK (code=${code}, signal=${signal})`),
          ),
        );
      });
      // Mark the eventual post-race rejection (after our deliberate SIGKILL)
      // as handled so it cannot surface as an unhandled rejection.
      earlyExit.catch(() => undefined);
      await Promise.race([firstAck, earlyExit]);
      await sleep(400 + Math.floor(Math.random() * 600));
      // The process must still be alive at the moment we kill it.
      expect(child.exitCode).toBeNull();
      child.kill('SIGKILL');
      // 'close' (unlike 'exit') also waits for the stdio pipes to drain, so
      // ACK lines still buffered at SIGKILL time are counted before asserting.
      await new Promise((resolve) => child.once('close', resolve));
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    expect(acked).toBeGreaterThan(0);

    const db = await openDatabase(dir);
    try {
      db.checkInvariants();
      expect(db.listIndexes()).toHaveLength(1);
      const { nodeCount, edgeCount } = db.stats();
      // Every tx creates exactly 2 nodes + 1 edge; recovered state must be whole transactions...
      expect(nodeCount % 2).toBe(0);
      expect(edgeCount).toBe(nodeCount / 2);
      // ...and must include at least everything that was acknowledged durable.
      expect(edgeCount).toBeGreaterThanOrEqual(acked);
    } finally {
      await db.close();
    }
    passed = true;
  } finally {
    if (passed) {
      await rm(dir, { recursive: true, force: true });
    } else {
      // Keep the crash artifacts: deleting the data directory here would
      // destroy exactly the evidence needed to debug a recovery failure.
      console.error(`[crash.test] failure detected; preserving crash artifacts at ${dir}`);
    }
  }
}

describe('crash safety', () => {
  it('survives SIGKILL mid-write: acked commits recovered, no partial batches', async () => {
    for (let i = 0; i < 5; i++) await crashOnce();
  }, 60_000);
});
