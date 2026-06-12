import { AtlasError } from '../errors.js';
import type { GraphStore } from '../store.js';
import type { EdgeRecord, NodeId } from '../types.js';
import { MinHeap } from './heap.js';
import { neighbors, requireNode, type PathResult, type Ticker } from './runner.js';

export interface ShortestPathOptions {
  from: NodeId;
  to: NodeId;
  type?: string;
  /** Edge property holding the weight; absent/non-number values count as 1. */
  weightProp?: string;
  /** Optional admissible heuristic turns Dijkstra into A*. */
  heuristic?: (node: NodeId) => number;
}

function weightOf(e: EdgeRecord, weightProp?: string): number {
  if (!weightProp) return 1;
  const v = e.props[weightProp];
  const w = typeof v === 'number' ? v : 1;
  if (w < 0)
    throw new AtlasError(
      'VALIDATION',
      `negative weight ${w} on edge ${e.id}; Dijkstra requires >= 0`,
    );
  return w;
}

export async function shortestPath(
  store: GraphStore,
  ticker: Ticker,
  opts: ShortestPathOptions,
): Promise<{ path: PathResult; cost: number } | null> {
  requireNode(store, opts.from);
  requireNode(store, opts.to);
  const h = opts.heuristic ?? (() => 0);
  const dist = new Map<NodeId, number>([[opts.from, 0]]);
  const prev = new Map<NodeId, { node: NodeId; edge: EdgeRecord }>();
  const settled = new Set<NodeId>();
  const heap = new MinHeap<NodeId>();
  heap.push(h(opts.from), opts.from);
  while (heap.size > 0) {
    const { value: id } = heap.pop()!;
    if (settled.has(id)) continue;
    settled.add(id);
    await ticker.tick();
    if (id === opts.to) break;
    const base = dist.get(id)!;
    for (const { edge, next } of neighbors(store, id, 'out', opts.type)) {
      const alt = base + weightOf(edge, opts.weightProp);
      if (alt < (dist.get(next) ?? Number.POSITIVE_INFINITY)) {
        dist.set(next, alt);
        prev.set(next, { node: id, edge });
        heap.push(alt + h(next), next);
      }
    }
  }
  if (!settled.has(opts.to)) return null;
  const nodes: NodeId[] = [opts.to];
  const edges: number[] = [];
  for (let at = opts.to; at !== opts.from; ) {
    const p = prev.get(at)!;
    edges.unshift(p.edge.id);
    nodes.unshift(p.node);
    at = p.node;
  }
  return { path: { nodes, edges }, cost: dist.get(opts.to)! };
}

const MAX_ALL_PATHS = 1000;

/** Unweighted: every distinct minimal-hop path (capped at MAX_ALL_PATHS), cost = hop count. */
export async function allShortestPaths(
  store: GraphStore,
  ticker: Ticker,
  opts: { from: NodeId; to: NodeId; type?: string },
): Promise<{ path: PathResult; cost: number }[]> {
  requireNode(store, opts.from);
  requireNode(store, opts.to);
  // BFS recording ALL minimal predecessors per node.
  const dist = new Map<NodeId, number>([[opts.from, 0]]);
  const preds = new Map<NodeId, { node: NodeId; edge: EdgeRecord }[]>();
  let frontier: NodeId[] = [opts.from];
  while (frontier.length > 0 && !dist.has(opts.to)) {
    const next: NodeId[] = [];
    for (const id of frontier) {
      await ticker.tick();
      const d = dist.get(id)!;
      for (const { edge, next: nb } of neighbors(store, id, 'out', opts.type)) {
        const known = dist.get(nb);
        if (known === undefined) {
          dist.set(nb, d + 1);
          preds.set(nb, [{ node: id, edge }]);
          next.push(nb);
        } else if (known === d + 1) {
          preds.get(nb)!.push({ node: id, edge });
        }
      }
    }
    frontier = next;
  }
  if (!dist.has(opts.to)) return [];
  const cost = dist.get(opts.to)!;
  // Walk every predecessor combination backward from `to`.
  const out: { path: PathResult; cost: number }[] = [];
  const walk: { node: NodeId; nodes: NodeId[]; edges: number[] }[] = [
    { node: opts.to, nodes: [opts.to], edges: [] },
  ];
  while (walk.length > 0 && out.length < MAX_ALL_PATHS) {
    const cur = walk.pop()!;
    await ticker.tick();
    if (cur.node === opts.from) {
      out.push({ path: { nodes: cur.nodes, edges: cur.edges }, cost });
      continue;
    }
    for (const p of preds.get(cur.node) ?? [])
      walk.push({ node: p.node, nodes: [p.node, ...cur.nodes], edges: [p.edge.id, ...cur.edges] });
  }
  return out;
}
