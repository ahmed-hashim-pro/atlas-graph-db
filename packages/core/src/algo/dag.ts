import { AtlasError } from '../errors.js';
import type { GraphStore } from '../store.js';
import type { NodeId } from '../types.js';
import { MinHeap } from './heap.js';
import { neighbors, type PathResult, type Ticker } from './runner.js';

/** Kahn's algorithm over out-edges; deterministic (id-ascending among ready nodes). */
export async function topoSort(
  store: GraphStore,
  ticker: Ticker,
  opts: { type?: string } = {},
): Promise<{ node: NodeId; order: number }[]> {
  const indegree = new Map<NodeId, number>();
  for (const id of store.nodes.keys()) {
    await ticker.tick();
    indegree.set(id, store.inDegree(id, opts.type));
  }
  const ready = new MinHeap<NodeId>();
  for (const [id, deg] of indegree) if (deg === 0) ready.push(id, id);
  const out: { node: NodeId; order: number }[] = [];
  while (ready.size > 0) {
    const { value: id } = ready.pop()!;
    await ticker.tick();
    out.push({ node: id, order: out.length });
    for (const { next } of neighbors(store, id, 'out', opts.type)) {
      const deg = indegree.get(next)! - 1;
      indegree.set(next, deg);
      if (deg === 0) ready.push(next, next);
    }
  }
  if (out.length < store.nodes.size)
    throw new AtlasError('VALIDATION', 'graph contains a cycle; topoSort requires a DAG');
  return out;
}

const DEFAULT_CYCLE_LIMIT = 100;

function canonicalSignature(nodes: NodeId[]): string {
  let minIdx = 0;
  for (let i = 1; i < nodes.length; i++) if (nodes[i]! < nodes[minIdx]!) minIdx = i;
  return [...nodes.slice(minIdx), ...nodes.slice(0, minIdx)].join(',');
}

/**
 * Directed cycle detection via DFS back edges. Returns up to `limit` distinct
 * simple cycles (deduped by rotation-canonical node signature). NOT an
 * exhaustive enumeration (that is exponential); [] means acyclic.
 */
export async function cycles(
  store: GraphStore,
  ticker: Ticker,
  opts: { type?: string; limit?: number } = {},
): Promise<{ cycle: PathResult }[]> {
  const limit = opts.limit ?? DEFAULT_CYCLE_LIMIT;
  const colors = new Map<NodeId, 1 | 2>(); // absent = white, 1 = on current path, 2 = done
  const out: { cycle: PathResult }[] = [];
  const seen = new Set<string>();

  interface Frame {
    id: NodeId;
    iter: Iterator<{ edge: { id: number }; next: NodeId }>;
  }

  for (const root of store.nodes.keys()) {
    if (out.length >= limit) break;
    if (colors.has(root)) continue;
    colors.set(root, 1);
    const frames: Frame[] = [{ id: root, iter: neighbors(store, root, 'out', opts.type) }];
    const pathNodes: NodeId[] = [root];
    const pathEdges: number[] = [];
    while (frames.length > 0 && out.length < limit) {
      const frame = frames[frames.length - 1]!;
      const step = frame.iter.next();
      if (!step.done) {
        await ticker.tick();
        const { edge, next } = step.value;
        const color = colors.get(next);
        if (color === 1) {
          const start = pathNodes.indexOf(next);
          const nodes = pathNodes.slice(start);
          const edges = [...pathEdges.slice(start), edge.id];
          const sig = canonicalSignature(nodes);
          if (!seen.has(sig)) {
            seen.add(sig);
            out.push({ cycle: { nodes, edges } });
          }
        } else if (color === undefined) {
          colors.set(next, 1);
          frames.push({ id: next, iter: neighbors(store, next, 'out', opts.type) });
          pathNodes.push(next);
          pathEdges.push(edge.id);
        }
      } else {
        colors.set(frame.id, 2);
        frames.pop();
        pathNodes.pop();
        pathEdges.pop();
      }
    }
  }
  return out;
}
