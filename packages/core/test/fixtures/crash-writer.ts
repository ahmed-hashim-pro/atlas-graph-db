// Child process: writes transactions forever, printing "ACK <txId>" per durable commit.
// The parent SIGKILLs it at a random moment, then verifies recovery.
import { openDatabase } from '../../src/database.js';

const dir = process.argv[2];
if (!dir) throw new Error('usage: crash-writer <dataDir>');

const db = await openDatabase(dir, { snapshotWalBytes: 8 * 1024 });
for (;;) {
  const { txId } = await db.transact((tx) => {
    const a = tx.createNode(['Crash'], { payload: 'x'.repeat(64) });
    const b = tx.createNode(['Crash'], {});
    tx.createEdge('LINK', a, b);
  });
  process.stdout.write(`ACK ${txId}\n`);
}
