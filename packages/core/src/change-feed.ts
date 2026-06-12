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
  private nextTxId = 1; // txId the NEXT emit is expected to carry
  private readonly subs = new Set<Subscription>();

  constructor(private readonly capacity = 1024) {}

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

  private schedule(sub: Subscription): void {
    if (sub.scheduled || sub.closed) return;
    sub.scheduled = true;
    queueMicrotask(() => {
      sub.scheduled = false;
      this.drain(sub);
    });
  }

  private drain(sub: Subscription): void {
    if (sub.closed) return;
    if (sub.cursor < this.oldest) {
      sub.closed = true;
      this.subs.delete(sub);
      sub.handler({ type: 'resync_required' });
      return;
    }
    while (sub.cursor < this.nextTxId && !sub.closed) {
      const batch = this.ring[sub.cursor - this.oldest]!;
      sub.cursor++;
      sub.handler({ type: 'batch', txId: batch.txId, ops: batch.ops });
    }
  }
}
