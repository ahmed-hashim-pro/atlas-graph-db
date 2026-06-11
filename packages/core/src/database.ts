import { mkdir, readFile, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { decodeBatch, encodeBatch } from './codec.js';
import { AtlasError } from './errors.js';
import { fsyncFile, scanDataDir, snapshotPath, walPath } from './files.js';
import { IdAllocator } from './id-allocator.js';
import { decodeSnapshot, encodeSnapshot } from './snapshot.js';
import { GraphStore } from './store.js';
import { TxBuilder } from './tx.js';
import type { EdgeId, EdgeRecord, NodeId, NodeRecord } from './types.js';
import { WalWriter, readWal, type FsyncMode } from './wal.js';
import { WriteQueue } from './write-queue.js';

export interface OpenOptions {
  fsync?: FsyncMode;
  snapshotWalBytes?: number;
}

export class AtlasDatabase {
  private constructor(
    private readonly dir: string,
    private readonly store: GraphStore,
    private readonly ids: IdAllocator,
    private wal: WalWriter,
    private walSeq: number,
    private lastTxId: number,
    private readonly opts: Required<OpenOptions>,
  ) {}

  private readonly queue = new WriteQueue();

  static async open(dir: string, opts: OpenOptions = {}): Promise<AtlasDatabase> {
    const options: Required<OpenOptions> = {
      fsync: opts.fsync ?? 'always',
      snapshotWalBytes: opts.snapshotWalBytes ?? 64 * 1024 * 1024,
    };
    await mkdir(dir, { recursive: true });
    const state = await scanDataDir(dir);
    const store = new GraphStore();
    let lastTxId = 0;
    let maxNodeId = 0;
    let maxEdgeId = 0;

    if (state.snapshotSeq !== null) {
      const snap = decodeSnapshot(await readFile(snapshotPath(dir, state.snapshotSeq)));
      for (const n of snap.nodes)
        store.applyOp({ op: 'createNode', id: n.id, labels: n.labels, props: n.props });
      for (const e of snap.edges)
        store.applyOp({
          op: 'createEdge',
          id: e.id,
          type: e.type,
          from: e.from,
          to: e.to,
          props: e.props,
        });
      lastTxId = snap.lastTxId;
      maxNodeId = snap.nextNodeId - 1;
      maxEdgeId = snap.nextEdgeId - 1;
    }

    const replaySeqs = state.walSeqs.filter((s) => s > (state.snapshotSeq ?? -1));
    for (const [i, seq] of replaySeqs.entries()) {
      const res = await readWal(walPath(dir, seq));
      if (res.corruptTail) {
        if (i < replaySeqs.length - 1)
          throw new AtlasError('WAL_CORRUPT', `corrupt record inside non-final segment ${seq}`);
        await truncate(walPath(dir, seq), res.validBytes);
        console.warn(
          `[atlas] recovery: truncated corrupt WAL tail of segment ${seq} at byte ${res.validBytes}`,
        );
      }
      for (const payload of res.payloads) {
        const batch = decodeBatch(payload);
        // lastTxId is seeded from the snapshot header above, so this contiguity
        // check holds both for cold replay (from 0) and post-snapshot replay.
        if (batch.txId !== lastTxId + 1)
          throw new AtlasError(
            'WAL_CORRUPT',
            `WAL replay: expected txId ${lastTxId + 1} but found ${batch.txId} in segment ${seq}`,
          );
        store.applyBatch(batch);
        lastTxId = batch.txId;
        for (const op of batch.ops) {
          if (op.op === 'createNode') maxNodeId = Math.max(maxNodeId, op.id);
          if (op.op === 'createEdge') maxEdgeId = Math.max(maxEdgeId, op.id);
        }
      }
    }

    const walSeq = replaySeqs.at(-1) ?? (state.snapshotSeq ?? 0) + 1;
    const wal = await WalWriter.open(walPath(dir, walSeq), options.fsync);
    const ids = new IdAllocator(maxNodeId + 1, maxEdgeId + 1);
    const db = new AtlasDatabase(dir, store, ids, wal, walSeq, lastTxId, options);
    if (state.snapshotSeq !== null) await db.cleanupBefore(state.snapshotSeq);
    return db;
  }

  private checkpointing: Promise<void> | null = null;

  checkpoint(): Promise<void> {
    this.checkpointing ??= this.runCheckpoint().finally(() => {
      this.checkpointing = null;
    });
    return this.checkpointing;
  }

  private async runCheckpoint(): Promise<void> {
    // Phase 1 — inside the write queue: rotate WAL, encode state (this is the brief write pause).
    const { buffer, snapSeq } = await this.queue.run(async () => {
      const snapSeq = this.walSeq;
      await this.wal.close();
      this.walSeq += 1;
      this.wal = await WalWriter.open(walPath(this.dir, this.walSeq), this.opts.fsync);
      const buffer = encodeSnapshot(this.store, this.lastTxId, this.ids.peek());
      return { buffer, snapSeq };
    });
    // Phase 2 — outside the queue: persist atomically, then delete covered files.
    const finalPath = snapshotPath(this.dir, snapSeq);
    const tmpPath = `${finalPath}.tmp`;
    await writeFile(tmpPath, buffer);
    await fsyncFile(tmpPath);
    await rename(tmpPath, finalPath);
    await this.cleanupBefore(snapSeq);
  }

  private async cleanupBefore(snapSeq: number): Promise<void> {
    const state = await scanDataDir(this.dir);
    for (const seq of state.walSeqs)
      if (seq <= snapSeq) await rm(walPath(this.dir, seq), { force: true });
    if (state.snapshotSeq !== null)
      for (let seq = state.snapshotSeq - 1; seq >= 0; seq--)
        await rm(snapshotPath(this.dir, seq), { force: true });
  }

  /**
   * Runs `fn` synchronously against a transaction builder and commits the
   * staged ops atomically. The callback MUST be synchronous: an async callback
   * could stage ops after the WAL fsync snapshot, silently diverging the
   * acknowledged in-memory state from what recovery replays. Thenable returns
   * are rejected at runtime.
   *
   * Returns the committed txId, or the reserved sentinel `{ txId: 0 }` when
   * the transaction staged no ops (nothing was written or applied).
   */
  transact(fn: (tx: TxBuilder) => void): Promise<{ txId: number }> {
    return this.queue.run(async () => {
      const tx = new TxBuilder(this.store, this.ids);
      const ret = fn(tx) as unknown;
      if (ret !== undefined && typeof (ret as PromiseLike<unknown>)?.then === 'function') {
        // Swallow the orphaned thenable's eventual rejection (if any) so the
        // VALIDATION error below is not shadowed by an unhandled rejection.
        (ret as PromiseLike<unknown>).then(undefined, () => undefined);
        throw new AtlasError(
          'VALIDATION',
          'transact callback must be synchronous; it returned a thenable',
        );
      }
      // Snapshot the staged ops: build() returns the live array, and the
      // single shared batch object backs both the WAL record and the
      // in-memory apply so they can never diverge.
      const ops = [...tx.build()];
      if (ops.length === 0) return { txId: 0 };
      const batch = { txId: this.lastTxId + 1, ops };
      await this.wal.append(encodeBatch(batch));
      this.store.applyBatch(batch);
      this.lastTxId = batch.txId;
      if (this.wal.bytesWritten >= this.opts.snapshotWalBytes && !this.checkpointing)
        void this.checkpoint().catch((err) => console.warn('[atlas] auto-checkpoint failed', err));
      return { txId: batch.txId };
    });
  }

  getNode(id: NodeId): NodeRecord | undefined {
    return this.store.getNode(id);
  }

  getEdge(id: EdgeId): EdgeRecord | undefined {
    return this.store.getEdge(id);
  }

  outEdges(id: NodeId, type?: string): EdgeRecord[] {
    return this.store.outEdges(id, type);
  }

  inEdges(id: NodeId, type?: string): EdgeRecord[] {
    return this.store.inEdges(id, type);
  }

  nodesByLabel(label: string): IterableIterator<NodeRecord> {
    return this.store.nodesByLabel(label);
  }

  stats(): { nodeCount: number; edgeCount: number } {
    return this.store.stats();
  }

  async close(): Promise<void> {
    if (this.checkpointing) await this.checkpointing;
    await this.queue.run(() => undefined);
    await this.wal.close();
  }
}

export const openDatabase = AtlasDatabase.open.bind(AtlasDatabase);
