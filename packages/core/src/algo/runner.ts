import { AtlasError } from '../errors.js';
import type { GraphStore } from '../store.js';
import type { LeaseProvider } from '../traversal/traversal.js';
import type { EdgeRecord, NodeId } from '../types.js';

export interface AlgoOptions {
  /** Read-lease budget; the algorithm aborts with TIMEOUT when it elapses. Default 30s. */
  budgetMs?: number;
}

export type Direction = 'out' | 'in' | 'both';

export interface PathResult {
  nodes: NodeId[];
  edges: number[];
}

const YIELD_EVERY = 10_000;

/** Cooperative-yield ticker bound to a lease. Call tick() once per unit of work. */
export class Ticker {
  private count = 0;

  constructor(private readonly lease: { release(): void; readonly expired: boolean }) {}

  async tick(): Promise<void> {
    if (this.lease.expired) throw new AtlasError('TIMEOUT', 'algorithm budget exhausted');
    if (++this.count % YIELD_EVERY !== 0) return;
    await new Promise((r) => setImmediate(r));
    if (this.lease.expired) throw new AtlasError('TIMEOUT', 'algorithm budget exhausted');
  }
}

/**
 * One read lease per algorithm invocation: point-in-time view, writes buffer,
 * lease released in finally. Algorithms must never call db.transact inside —
 * the write would queue behind their own lease until the budget expires.
 */
export async function withAlgoLease<T>(
  leases: LeaseProvider,
  opts: AlgoOptions,
  fn: (ticker: Ticker) => Promise<T>,
): Promise<T> {
  const lease = await leases.acquireReadLease({ budgetMs: opts.budgetMs });
  try {
    // A non-positive budget is exhausted by definition. Checking here keeps the
    // semantics deterministic: the 0ms timer is a macrotask and would never
    // beat a small synchronous algorithm to the punch.
    if ((opts.budgetMs ?? 30_000) <= 0)
      throw new AtlasError('TIMEOUT', 'algorithm budget exhausted');
    return await fn(new Ticker(lease));
  } finally {
    lease.release();
  }
}

/** Directed/typed neighbor iteration shared by every algorithm. */
export function* neighbors(
  store: GraphStore,
  id: NodeId,
  direction: Direction,
  type?: string,
): IterableIterator<{ edge: EdgeRecord; next: NodeId }> {
  if (direction !== 'in') for (const e of store.outEdges(id, type)) yield { edge: e, next: e.to };
  if (direction !== 'out') for (const e of store.inEdges(id, type)) yield { edge: e, next: e.from };
}

export function requireNode(store: GraphStore, id: NodeId): void {
  if (!store.getNode(id)) throw new AtlasError('NOT_FOUND', `node ${id} not found`);
}
