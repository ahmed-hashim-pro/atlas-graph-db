import { mkdir, truncate } from 'node:fs/promises';
import { decodeBatch, encodeBatch } from './codec.js';
import { AtlasError } from './errors.js';
import { scanDataDir, walPath } from './files.js';
import { IdAllocator } from './id-allocator.js';
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
        // NOTE(Task 16): this check assumes replay starts from txId 0. Once
        // snapshots land, lastTxId must be seeded from the snapshot header
        // before replay, or the first post-snapshot batch will spuriously fail.
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
    return new AtlasDatabase(dir, store, ids, wal, walSeq, lastTxId, options);
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
    await this.queue.run(() => undefined);
    await this.wal.close();
  }
}

export const openDatabase = AtlasDatabase.open.bind(AtlasDatabase);
