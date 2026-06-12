import { mkdir, readFile, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { AlgoFacade } from './algo/facade.js';
import { ChangeFeed, type ChangeEvent } from './change-feed.js';
import { decodeBatch, encodeBatch } from './codec.js';
import { AtlasError } from './errors.js';
import {
  fsyncDir,
  fsyncFile,
  removeStaleSnapshotTmp,
  scanDataDir,
  snapshotPath,
  walPath,
} from './files.js';
import { IdAllocator } from './id-allocator.js';
import type { ScalarValue } from './index/keys.js';
import type { RangeQuery } from './index/property-index.js';
import type { SchemaSummary } from './schema.js';
import { decodeSnapshot, encodeSnapshot } from './snapshot.js';
import { GraphStore } from './store.js';
import { GraphView } from './traversal/traversal.js';
import { TxBuilder } from './tx.js';
import type { EdgeId, EdgeRecord, IndexDef, NodeId, NodeRecord } from './types.js';
import { WalWriter, readWal, type FsyncMode } from './wal.js';
import { WriteQueue } from './write-queue.js';

export interface OpenOptions {
  fsync?: FsyncMode;
  snapshotWalBytes?: number;
}

export interface ReadLease {
  /** Idempotent. Lets buffered writes proceed. */
  release(): void;
  /** True once the budget elapsed and the queue was force-released. */
  readonly expired: boolean;
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
  ) {
    // Seed the feed with the recovered txId so a fresh default subscriber's
    // cursor matches the next commit (otherwise a reopened database would
    // hand every new subscriber a spurious resync_required on first commit).
    // Constructed in the body, not a field initializer: under ES2022+
    // class-field semantics initializers run before parameter properties are
    // assigned, so they cannot read `lastTxId`.
    this.feed = new ChangeFeed(1024, lastTxId + 1);
  }

  private readonly queue = new WriteQueue();

  private readonly feed: ChangeFeed;

  private algoFacade: AlgoFacade | undefined;

  /** Graph algorithms (spec §4.7), lease-protected. */
  get algo(): AlgoFacade {
    return (this.algoFacade ??= new AlgoFacade(this.store, this));
  }

  /**
   * Read-only handle to the committed store, for query engines layered on
   * core (@atlas/query). Mutating through it bypasses the WAL — never write.
   */
  get graphStore(): GraphStore {
    return this.store;
  }

  static async open(dir: string, opts: OpenOptions = {}): Promise<AtlasDatabase> {
    const options: Required<OpenOptions> = {
      fsync: opts.fsync ?? 'always',
      snapshotWalBytes: opts.snapshotWalBytes ?? 64 * 1024 * 1024,
    };
    await mkdir(dir, { recursive: true });
    await removeStaleSnapshotTmp(dir);
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
      for (const def of snap.indexes ?? []) store.applyOp({ op: 'createIndex', def });
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
  private closed = false;

  checkpoint(): Promise<void> {
    // No-op once close() has begun: a checkpoint started after the close
    // drain would open a fresh WalWriter that nothing ever closes.
    if (this.closed) return Promise.resolve();
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
      await fsyncDir(this.dir);
      const buffer = encodeSnapshot(this.store, this.lastTxId, this.ids.peek());
      return { buffer, snapSeq };
    });
    // Phase 2 — outside the queue: persist atomically, then delete covered files.
    const finalPath = snapshotPath(this.dir, snapSeq);
    const tmpPath = `${finalPath}.tmp`;
    await writeFile(tmpPath, buffer);
    await fsyncFile(tmpPath);
    await rename(tmpPath, finalPath);
    await fsyncDir(this.dir);
    await this.cleanupBefore(snapSeq);
  }

  private async cleanupBefore(snapSeq: number): Promise<void> {
    const state = await scanDataDir(this.dir);
    for (const seq of state.walSeqs)
      if (seq <= snapSeq) await rm(walPath(this.dir, seq), { force: true });
    if (state.snapshotSeq !== null)
      for (let seq = state.snapshotSeq - 1; seq >= 0; seq--)
        await rm(snapshotPath(this.dir, seq), { force: true });
    await fsyncDir(this.dir);
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
      // build() returns a fresh canonically-ordered array (data ops, then net
      // DDL); the single shared batch object backs both the WAL record and
      // the in-memory apply so they can never diverge.
      const ops = tx.build();
      if (ops.length === 0) return { txId: 0 };
      this.store.indexes.validateBatch(ops, this.store);
      const batch = { txId: this.lastTxId + 1, ops };
      await this.wal.append(encodeBatch(batch));
      this.store.applyBatch(batch);
      this.lastTxId = batch.txId;
      this.feed.emit(batch);
      if (this.wal.bytesWritten >= this.opts.snapshotWalBytes && !this.checkpointing)
        void this.checkpoint().catch((err) => console.warn('[atlas] auto-checkpoint failed', err));
      return { txId: batch.txId };
    });
  }

  /**
   * Acquire a read lease: the write queue holds (writes buffer, nothing
   * applies) until release() or the budget elapses — whichever comes first.
   * Yielding readers (stream(), future algorithms) use this for a
   * point-in-time view; synchronous reads never need it.
   *
   * A lease that is never release()d — e.g. an abandoned stream() iterator —
   * holds writes (and delays close()) until its budget expires. Always
   * release in a finally, or consume streams with for-await.
   */
  acquireReadLease(opts: { budgetMs?: number } = {}): Promise<ReadLease> {
    const budgetMs = opts.budgetMs ?? 30_000;
    return new Promise<ReadLease>((resolveAcquire) => {
      void this.queue.run(
        () =>
          new Promise<void>((resolveHold) => {
            let expired = false;
            let done = false;
            const finish = (byExpiry: boolean): void => {
              if (done) return;
              done = true;
              expired = byExpiry;
              clearTimeout(timer);
              resolveHold();
            };
            const timer = setTimeout(() => finish(true), budgetMs);
            timer.unref();
            resolveAcquire({
              release: () => finish(false),
              get expired() {
                return expired;
              },
            });
          }),
      );
    });
  }

  /**
   * Subscribe to committed batches. Delivery is asynchronous; on overflow the
   * subscriber receives one resync_required and is closed. Cursors are
   * per-process: after a restart, re-read state and subscribe fresh — the
   * feed is seeded from the recovered txId, so a default subscription resumes
   * cleanly at the next commit. A handler that throws is logged and its
   * subscription closed. close() delivers any still-buffered batches and then
   * closes all subscriptions; no terminal event is emitted.
   */
  subscribe(handler: (e: ChangeEvent) => void, opts: { fromTxId?: number } = {}): () => void {
    return this.feed.subscribe(handler, opts);
  }

  /** Fluent traversal entry point over committed state. */
  graph(): GraphView {
    return new GraphView(this.store, this);
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

  listIndexes(): IndexDef[] {
    return this.store.indexes.defs();
  }

  schema(): SchemaSummary {
    return this.store.schema.summary();
  }

  createIndex(def: IndexDef): Promise<{ txId: number }> {
    return this.transact((tx) => tx.createIndex(def));
  }

  dropIndex(def: IndexDef): Promise<{ txId: number }> {
    return this.transact((tx) => tx.dropIndex(def));
  }

  /** undefined = no scalar index on (label, property); empty = indexed, no match. */
  lookupExact(
    label: string,
    property: string,
    value: ScalarValue,
  ): ReadonlySet<NodeId> | undefined {
    return this.store.indexes.lookupExact(label, property, value);
  }

  /** Throws NOT_FOUND if no scalar index exists. */
  lookupRange(label: string, property: string, q: RangeQuery): IterableIterator<NodeId> {
    return this.store.indexes.lookupRange(label, property, q);
  }

  /** undefined = no fulltext index on (label, property). */
  searchText(
    label: string,
    property: string,
    query: string,
    opts: { prefix?: boolean } = {},
  ): Set<NodeId> | undefined {
    return this.store.indexes.searchText(label, property, query, opts);
  }

  /**
   * Verifies the underlying store's internal invariants, throwing AtlasError
   * on any violation. Exposed primarily for tests (crash/property suites) so
   * they need not reach through the private store field.
   */
  checkInvariants(): void {
    this.store.checkInvariants();
  }

  async close(): Promise<void> {
    this.closed = true;
    // In-flight transacts drain first; any checkpoint they (or callers)
    // started before `closed` was set must finish before the WAL closes.
    await this.drainCheckpoints();
    await this.queue.run(() => undefined);
    await this.drainCheckpoints();
    // Flush buffered batches to subscribers, then end every subscription so
    // none is left silently dangling (see subscribe() for the contract).
    this.feed.closeAll();
    await this.wal.close();
  }

  private async drainCheckpoints(): Promise<void> {
    for (let cp = this.checkpointing; cp !== null; cp = this.checkpointing) await cp;
  }
}

export const openDatabase = AtlasDatabase.open.bind(AtlasDatabase);
