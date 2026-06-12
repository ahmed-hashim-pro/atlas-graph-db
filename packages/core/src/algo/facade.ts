import type { GraphStore } from '../store.js';
import type { LeaseProvider } from '../traversal/traversal.js';
import type { NodeId } from '../types.js';
import { betweenness, type BetweennessOptions } from './betweenness.js';
import { components, type ComponentsOptions } from './components.js';
import { topoSort, cycles } from './dag.js';
import { louvain, type LouvainOptions } from './louvain.js';
import { pagerank, type PagerankOptions } from './pagerank.js';
import { withAlgoLease, type AlgoOptions, type Direction, type PathResult } from './runner.js';
import { allShortestPaths, shortestPath, type ShortestPathOptions } from './shortest-path.js';
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

  degree(
    opts: { direction?: Direction } & AlgoOptions = {},
  ): Promise<{ node: NodeId; score: number }[]> {
    return withAlgoLease(this.leases, opts, (t) => degree(this.store, t, opts));
  }

  shortestPath(
    opts: ShortestPathOptions & AlgoOptions,
  ): Promise<{ path: PathResult; cost: number } | null> {
    return withAlgoLease(this.leases, opts, (t) => shortestPath(this.store, t, opts));
  }

  allShortestPaths(
    opts: { from: NodeId; to: NodeId; type?: string } & AlgoOptions,
  ): Promise<{ path: PathResult; cost: number }[]> {
    return withAlgoLease(this.leases, opts, (t) => allShortestPaths(this.store, t, opts));
  }

  components(
    opts: ComponentsOptions & AlgoOptions = {},
  ): Promise<{ node: NodeId; component: number }[]> {
    return withAlgoLease(this.leases, opts, (t) => components(this.store, t, opts));
  }

  topoSort(opts: { type?: string } & AlgoOptions = {}): Promise<{ node: NodeId; order: number }[]> {
    return withAlgoLease(this.leases, opts, (t) => topoSort(this.store, t, opts));
  }

  cycles(
    opts: { type?: string; limit?: number } & AlgoOptions = {},
  ): Promise<{ cycle: PathResult }[]> {
    return withAlgoLease(this.leases, opts, (t) => cycles(this.store, t, opts));
  }

  pagerank(opts: PagerankOptions & AlgoOptions = {}): Promise<{ node: NodeId; score: number }[]> {
    return withAlgoLease(this.leases, opts, (t) => pagerank(this.store, t, opts));
  }

  louvain(opts: LouvainOptions & AlgoOptions = {}): Promise<{ node: NodeId; community: number }[]> {
    return withAlgoLease(this.leases, opts, (t) => louvain(this.store, t, opts));
  }

  betweenness(
    opts: BetweennessOptions & AlgoOptions = {},
  ): Promise<{ node: NodeId; score: number }[]> {
    return withAlgoLease(this.leases, opts, (t) => betweenness(this.store, t, opts));
  }
}
