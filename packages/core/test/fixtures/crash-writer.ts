// Child process: writes transactions forever, printing "ACK <n>" per durable
// DATA commit (a counter, NOT the txId — the createIndex tx below consumes a
// txId, and the parent compares acked against recovered edge counts).
// The parent SIGKILLs it at a random moment, then verifies recovery.
import { openDatabase } from '../../src/database.js';

const dir = process.argv[2];
if (!dir) throw new Error('usage: crash-writer <dataDir>');

const db = await openDatabase(dir, { snapshotWalBytes: 8 * 1024 });
if (db.listIndexes().length === 0)
  await db.createIndex({ kind: 'property', label: 'Crash', property: 'payload' });
let committed = 0;
for (;;) {
  await db.transact((tx) => {
    const a = tx.createNode(['Crash'], { payload: 'x'.repeat(64) });
    const b = tx.createNode(['Crash'], {});
    tx.createEdge('LINK', a, b);
  });
  process.stdout.write(`ACK ${++committed}\n`);
}
