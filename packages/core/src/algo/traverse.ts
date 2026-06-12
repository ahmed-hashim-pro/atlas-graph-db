import type { GraphStore } from '../store.js';
import type { NodeId } from '../types.js';
import { neighbors, requireNode, type Direction, type Ticker } from './runner.js';

export interface TraverseOptions {
  from: NodeId;
  type?: string;
  maxDepth?: number;
  direction?: Direction;
}

export async function bfs(
  store: GraphStore,
  ticker: Ticker,
  opts: TraverseOptions,
): Promise<{ node: NodeId; depth: number }[]> {
  requireNode(store, opts.from);
  const direction = opts.direction ?? 'out';
  const maxDepth = opts.maxDepth ?? Number.POSITIVE_INFINITY;
  const out: { node: NodeId; depth: number }[] = [];
  const seen = new Set<NodeId>([opts.from]);
  let frontier: NodeId[] = [opts.from];
  let depth = 0;
  while (frontier.length > 0 && depth <= maxDepth) {
    const next: NodeId[] = [];
    for (const id of frontier) {
      await ticker.tick();
      out.push({ node: id, depth });
      for (const { next: nb } of neighbors(store, id, direction, opts.type)) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        next.push(nb);
      }
    }
    frontier = next;
    depth++;
  }
  return out;
}

export async function dfs(
  store: GraphStore,
  ticker: Ticker,
  opts: TraverseOptions,
): Promise<{ node: NodeId; depth: number }[]> {
  requireNode(store, opts.from);
  const direction = opts.direction ?? 'out';
  const maxDepth = opts.maxDepth ?? Number.POSITIVE_INFINITY;
  const out: { node: NodeId; depth: number }[] = [];
  const seen = new Set<NodeId>();
  const stack: { id: NodeId; depth: number }[] = [{ id: opts.from, depth: 0 }];
  while (stack.length > 0) {
    const { id, depth } = stack.pop()!;
    if (seen.has(id) || depth > maxDepth) continue;
    seen.add(id);
    await ticker.tick();
    out.push({ node: id, depth });
    for (const { next } of neighbors(store, id, direction, opts.type))
      if (!seen.has(next)) stack.push({ id: next, depth: depth + 1 });
  }
  return out;
}

export async function degree(
  store: GraphStore,
  ticker: Ticker,
  opts: { direction?: Direction } = {},
): Promise<{ node: NodeId; score: number }[]> {
  const direction = opts.direction ?? 'both';
  const out: { node: NodeId; score: number }[] = [];
  for (const id of store.nodes.keys()) {
    await ticker.tick();
    let score = 0;
    if (direction !== 'in') score += store.outEdges(id).length;
    if (direction !== 'out') score += store.inEdges(id).length;
    out.push({ node: id, score });
  }
  return out;
}
