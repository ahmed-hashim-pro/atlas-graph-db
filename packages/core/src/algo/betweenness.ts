import type { GraphStore } from '../store.js';
import type { NodeId } from '../types.js';
import { neighbors, type Ticker } from './runner.js';

export interface BetweennessOptions {
  /** Source-sample size; forces sampling even below the guard. */
  sampleK?: number;
  /** Above this node count, sampling kicks in automatically. Default 2000. */
  exactGuard?: number;
}

/**
 * Brandes betweenness (unweighted, directed, out-edges). Exact when the node
 * count is within exactGuard and no sampleK is given; otherwise runs from a
 * deterministic evenly-spaced sample of k sources (over id-sorted nodes) and
 * scales contributions by n/k.
 */
export async function betweenness(
  store: GraphStore,
  ticker: Ticker,
  opts: BetweennessOptions = {},
): Promise<{ node: NodeId; score: number }[]> {
  const ids = [...store.nodes.keys()].sort((a, b) => a - b);
  const n = ids.length;
  if (n === 0) return [];
  const guard = opts.exactGuard ?? 2000;
  let sources: NodeId[];
  let scale = 1;
  if (opts.sampleK !== undefined || n > guard) {
    const k = Math.min(opts.sampleK ?? 200, n);
    const stride = n / k;
    sources = Array.from({ length: k }, (_, i) => ids[Math.floor(i * stride)]!);
    scale = n / k;
  } else {
    sources = ids;
  }

  const bc = new Map<NodeId, number>(ids.map((id) => [id, 0]));
  for (const s of sources) {
    const stack: NodeId[] = [];
    const preds = new Map<NodeId, NodeId[]>();
    const sigma = new Map<NodeId, number>([[s, 1]]);
    const dist = new Map<NodeId, number>([[s, 0]]);
    const queue: NodeId[] = [s];
    let qi = 0;
    while (qi < queue.length) {
      const v = queue[qi++]!;
      await ticker.tick();
      stack.push(v);
      for (const { next: w } of neighbors(store, v, 'out')) {
        if (!dist.has(w)) {
          dist.set(w, dist.get(v)! + 1);
          queue.push(w);
        }
        if (dist.get(w) === dist.get(v)! + 1) {
          sigma.set(w, (sigma.get(w) ?? 0) + sigma.get(v)!);
          let p = preds.get(w);
          if (!p) {
            p = [];
            preds.set(w, p);
          }
          p.push(v);
        }
      }
    }
    const delta = new Map<NodeId, number>();
    for (let i = stack.length - 1; i >= 0; i--) {
      const w = stack[i]!;
      await ticker.tick();
      for (const v of preds.get(w) ?? []) {
        const inc = (sigma.get(v)! / sigma.get(w)!) * (1 + (delta.get(w) ?? 0));
        delta.set(v, (delta.get(v) ?? 0) + inc);
      }
      if (w !== s) bc.set(w, bc.get(w)! + (delta.get(w) ?? 0) * scale);
    }
  }
  return ids.map((id) => ({ node: id, score: bc.get(id)! }));
}
