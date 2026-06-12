import type { GraphStore } from '../store.js';
import type { LeaseProvider } from '../traversal/traversal.js';
import type { NodeId } from '../types.js';
import { withAlgoLease, type AlgoOptions, type Direction } from './runner.js';
import { bfs, dfs, degree, type TraverseOptions } from './traverse.js';

/**
 * db.algo — every method runs read-only under one read lease with cooperative
 * yielding; budgets via { budgetMs }. Parameter names and result columns
 * mirror the spec §5.2 CALL table. Never call db.transact from inside an
 * algorithm callback path: the write would buffer behind the lease.
 */
export class AlgoFacade {
  constructor(
    private readonly store: GraphStore,
    private readonly leases: LeaseProvider,
  ) {}

  bfs(opts: TraverseOptions & AlgoOptions): Promise<{ node: NodeId; depth: number }[]> {
    return withAlgoLease(this.leases, opts, (t) => bfs(this.store, t, opts));
  }

  dfs(opts: TraverseOptions & AlgoOptions): Promise<{ node: NodeId; depth: number }[]> {
    return withAlgoLease(this.leases, opts, (t) => dfs(this.store, t, opts));
  }

  degree(opts: { direction?: Direction } & AlgoOptions = {}): Promise<{ node: NodeId; score: number }[]> {
    return withAlgoLease(this.leases, opts, (t) => degree(this.store, t, opts));
  }
}
