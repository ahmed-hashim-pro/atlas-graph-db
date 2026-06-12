import { AtlasError } from '../errors.js';
import type { ScalarValue } from '../index/keys.js';
import type { RangeQuery } from '../index/property-index.js';
import type { GraphStore } from '../store.js';
import type { EdgeRecord, NodeRecord, Props } from '../types.js';

/** Internal pipeline element: the current record plus the route that produced it. */
export interface Step<T> {
  value: T;
  path: { nodes: NodeRecord[]; edges: EdgeRecord[] };
}

export interface TraversalPath {
  nodes: NodeRecord[];
  edges: EdgeRecord[];
}

type Source<T> = () => IterableIterator<Step<T>>;

function* mapIter<A, B>(it: IterableIterator<A>, f: (a: A) => B): IterableIterator<B> {
  for (const a of it) yield f(a);
}

abstract class BaseTraversal<T extends { id: number; props: Props }> {
  constructor(
    protected readonly store: GraphStore,
    protected readonly source: Source<T>,
  ) {}

  protected abstract clone(source: Source<T>): this;

  where(pred: (props: Props, record: T) => boolean): this {
    const src = this.source;
    return this.clone(function* () {
      for (const s of src()) if (pred(s.value.props, s.value)) yield s;
    });
  }

  dedup(): this {
    const src = this.source;
    return this.clone(function* () {
      const seen = new Set<number>();
      for (const s of src()) {
        if (seen.has(s.value.id)) continue;
        seen.add(s.value.id);
        yield s;
      }
    });
  }

  limit(n: number): this {
    const src = this.source;
    return this.clone(function* () {
      if (n <= 0) return;
      let count = 0;
      for (const s of src()) {
        yield s;
        if (++count >= n) return;
      }
    });
  }

  skip(n: number): this {
    const src = this.source;
    return this.clone(function* () {
      let count = 0;
      for (const s of src()) if (count++ >= n) yield s;
    });
  }

  /** Materializes the upstream — ordering cannot stream. */
  order(cmp: (a: T, b: T) => number): this {
    const src = this.source;
    return this.clone(function* () {
      yield* [...src()].sort((a, b) => cmp(a.value, b.value));
    });
  }

  toArray(): T[] {
    return [...mapIter(this.source(), (s) => s.value)];
  }

  first(): T | undefined {
    for (const s of this.source()) return s.value;
    return undefined;
  }

  count(): number {
    let n = 0;
    const it = this.source();
    while (!it.next().done) n++;
    return n;
  }

  sum(sel: (record: T) => number): number {
    let total = 0;
    for (const s of this.source()) total += sel(s.value);
    return total;
  }

  min(sel: (record: T) => number): number | undefined {
    let best: number | undefined;
    for (const s of this.source()) {
      const v = sel(s.value);
      if (best === undefined || v < best) best = v;
    }
    return best;
  }

  max(sel: (record: T) => number): number | undefined {
    let best: number | undefined;
    for (const s of this.source()) {
      const v = sel(s.value);
      if (best === undefined || v > best) best = v;
    }
    return best;
  }

  avg(sel: (record: T) => number): number | undefined {
    let total = 0;
    let n = 0;
    for (const s of this.source()) {
      total += sel(s.value);
      n++;
    }
    return n === 0 ? undefined : total / n;
  }

  paths(): TraversalPath[] {
    return [...mapIter(this.source(), (s) => s.path)];
  }

  /** Internal: raw step iterator (stream() in a later task consumes this). */
  steps(): IterableIterator<Step<T>> {
    return this.source();
  }
}

export class NodeTraversal extends BaseTraversal<NodeRecord> {
  static fromIds(store: GraphStore, ids: () => Iterable<number>): NodeTraversal {
    return new NodeTraversal(store, function* () {
      for (const id of ids()) {
        const n = store.getNode(id);
        if (n) yield { value: n, path: { nodes: [n], edges: [] } };
      }
    });
  }

  protected clone(source: Source<NodeRecord>): this {
    return new NodeTraversal(this.store, source) as this;
  }

  private hop(dir: 'out' | 'in' | 'both', type?: string): NodeTraversal {
    const { store, source } = this;
    return new NodeTraversal(store, function* () {
      for (const s of source()) {
        const hops: { edge: EdgeRecord; nextId: number }[] = [];
        if (dir !== 'in')
          for (const e of store.outEdges(s.value.id, type)) hops.push({ edge: e, nextId: e.to });
        if (dir !== 'out')
          for (const e of store.inEdges(s.value.id, type)) hops.push({ edge: e, nextId: e.from });
        for (const h of hops) {
          const n = store.getNode(h.nextId)!;
          yield {
            value: n,
            path: { nodes: [...s.path.nodes, n], edges: [...s.path.edges, h.edge] },
          };
        }
      }
    });
  }

  out(type?: string): NodeTraversal {
    return this.hop('out', type);
  }

  in(type?: string): NodeTraversal {
    return this.hop('in', type);
  }

  both(type?: string): NodeTraversal {
    return this.hop('both', type);
  }

  outE(type?: string): EdgeTraversal {
    const { store, source } = this;
    return new EdgeTraversal(store, function* () {
      for (const s of source())
        for (const e of store.outEdges(s.value.id, type))
          yield { value: e, path: { nodes: s.path.nodes, edges: [...s.path.edges, e] } };
    });
  }

  inE(type?: string): EdgeTraversal {
    const { store, source } = this;
    return new EdgeTraversal(store, function* () {
      for (const s of source())
        for (const e of store.inEdges(s.value.id, type))
          yield { value: e, path: { nodes: s.path.nodes, edges: [...s.path.edges, e] } };
    });
  }
}

export class EdgeTraversal extends BaseTraversal<EdgeRecord> {
  constructor(store: GraphStore, source: Source<EdgeRecord>) {
    super(store, source);
  }

  protected clone(source: Source<EdgeRecord>): this {
    return new EdgeTraversal(this.store, source) as this;
  }

  /** Hop to each edge's source node. */
  fromNode(): NodeTraversal {
    return this.endpoint('from');
  }

  /** Hop to each edge's target node. */
  toNode(): NodeTraversal {
    return this.endpoint('to');
  }

  private endpoint(side: 'from' | 'to'): NodeTraversal {
    const { store, source } = this;
    return new NodeTraversal(store, function* () {
      for (const s of source()) {
        const n = store.getNode(s.value[side])!;
        yield { value: n, path: { nodes: [...s.path.nodes, n], edges: s.path.edges } };
      }
    });
  }
}

export class GraphView {
  constructor(private readonly store: GraphStore) {}

  /** All nodes, or all nodes with the given label (served by the label index). */
  nodes(label?: string): NodeTraversal {
    const store = this.store;
    return NodeTraversal.fromIds(store, () =>
      label === undefined ? store.nodes.keys() : store.nodeIdsByLabel(label),
    );
  }

  /** Single-node source; empty if the id does not exist. */
  node(id: number): NodeTraversal {
    return NodeTraversal.fromIds(this.store, () => [id]);
  }

  /**
   * Index-backed source. Pass a scalar for exact match or a RangeQuery
   * ({gt/gte/lt/lte}) for ranges. Throws NOT_FOUND when (label, property) has
   * no scalar index — explicit beats a silent full scan.
   */
  nodesWhere(label: string, property: string, q: ScalarValue | RangeQuery): NodeTraversal {
    const store = this.store;
    if (typeof q === 'object' && !(q instanceof Date)) {
      return NodeTraversal.fromIds(store, () => store.indexes.lookupRange(label, property, q));
    }
    return NodeTraversal.fromIds(store, () => {
      const ids = store.indexes.lookupExact(label, property, q);
      // Message must stay in sync with IndexRegistry.lookupRange, which throws
      // the same NOT_FOUND for the range branch above.
      if (ids === undefined)
        throw new AtlasError('NOT_FOUND', `no property index on ${label}.${property}`);
      return ids;
    });
  }

  /** Fulltext-backed source. Throws NOT_FOUND when (label, property) has no fulltext index. */
  search(
    label: string,
    property: string,
    query: string,
    opts: { prefix?: boolean } = {},
  ): NodeTraversal {
    const store = this.store;
    return NodeTraversal.fromIds(store, () => {
      const ids = store.indexes.searchText(label, property, query, opts);
      if (ids === undefined)
        throw new AtlasError('NOT_FOUND', `no fulltext index on ${label}.${property}`);
      return ids;
    });
  }
}
