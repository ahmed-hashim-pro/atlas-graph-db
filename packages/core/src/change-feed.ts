import type { CommittedBatch } from './types.js';

export type ChangeEvent =
  | { type: 'batch'; txId: number; ops: CommittedBatch['ops'] }
  | { type: 'resync_required' };

interface Subscription {
  handler: (e: ChangeEvent) => void;
  /** Next txId this subscriber expects. */
  cursor: number;
  closed: boolean;
  scheduled: boolean;
}

/**
 * Bounded in-process feed of committed batches. Delivery is asynchronous
 * (microtask) so handlers never block transact(). A subscriber whose cursor
 * falls out of the retained window receives one resync_required and is closed
 * — it must re-read current state and resubscribe.
 */
export class ChangeFeed {
  private readonly ring: CommittedBatch[] = [];
  /** txId the NEXT emit is expected to carry. */
  private nextTxId: number;
  private readonly subs = new Set<Subscription>();

  /**
   * @param startTxId txId the next emit will carry. A database recovered at
   * lastTxId = N must seed its feed with N + 1 so a fresh default subscriber's
   * cursor lines up with the first post-recovery commit.
   */
  constructor(
    private readonly capacity = 1024,
    startTxId = 1,
  ) {
    this.nextTxId = startTxId;
  }

  /** Oldest txId still retained, or nextTxId when the ring is empty. */
  private get oldest(): number {
    return this.nextTxId - this.ring.length;
  }

  emit(batch: CommittedBatch): void {
    this.nextTxId = batch.txId + 1;
    this.ring.push(batch);
    if (this.ring.length > this.capacity) this.ring.shift();
    for (const sub of this.subs) this.schedule(sub);
  }

  /**
   * Subscribe to the feed. A handler that throws has its subscription closed
   * (the error is logged, never rethrown), so one misbehaving observer cannot
   * crash the process or starve other subscribers.
   */
  subscribe(handler: (e: ChangeEvent) => void, opts: { fromTxId?: number } = {}): () => void {
    const sub: Subscription = {
      handler,
      cursor: opts.fromTxId ?? this.nextTxId,
      closed: false,
      scheduled: false,
    };
    this.subs.add(sub);
    this.schedule(sub);
    return () => {
      sub.closed = true;
      this.subs.delete(sub);
    };
  }

  /**
   * Synchronously deliver any batches still buffered for each subscriber,
   * then close every subscription. No terminal event is emitted. Called by
   * AtlasDatabase.close().
   */
  closeAll(): void {
    for (const sub of [...this.subs]) {
      this.drain(sub);
      sub.closed = true;
    }
    this.subs.clear();
  }

  private schedule(sub: Subscription): void {
    if (sub.scheduled || sub.closed) return;
    sub.scheduled = true;
    queueMicrotask(() => {
      sub.scheduled = false;
      this.drain(sub);
    });
  }

  private drain(sub: Subscription): void {
    // The staleness check is re-run every iteration: a handler may re-enter
    // emit() synchronously and evict the in-flight cursor mid-loop.
    while (!sub.closed) {
      if (sub.cursor < this.oldest) {
        sub.closed = true;
        this.subs.delete(sub);
        this.invoke(sub, { type: 'resync_required' });
        return;
      }
      if (sub.cursor >= this.nextTxId) return;
      const batch = this.ring[sub.cursor - this.oldest]!;
      sub.cursor++;
      this.invoke(sub, { type: 'batch', txId: batch.txId, ops: batch.ops });
    }
  }

  /** Guarded handler call: a throw closes the subscription, never escapes. */
  private invoke(sub: Subscription, event: ChangeEvent): void {
    try {
      sub.handler(event);
    } catch (err) {
      sub.closed = true;
      this.subs.delete(sub);
      console.error('[atlas] change feed handler threw; subscription closed', err);
    }
  }
}
