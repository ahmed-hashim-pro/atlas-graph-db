import { AtlasError } from '../errors.js';
import type { GraphStore } from '../store.js';
import type { NodeId } from '../types.js';
import type { Ticker } from './runner.js';

export interface PagerankOptions {
  damping?: number;
  iterations?: number;
}

export async function pagerank(
  store: GraphStore,
  ticker: Ticker,
  opts: PagerankOptions = {},
): Promise<{ node: NodeId; score: number }[]> {
  const damping = opts.damping ?? 0.85;
  const iterations = opts.iterations ?? 20;
  if (damping <= 0 || damping >= 1)
    throw new AtlasError('VALIDATION', `damping must be in (0,1), got ${damping}`);
  if (iterations < 1) throw new AtlasError('VALIDATION', 'iterations must be >= 1');

  const ids = [...store.nodes.keys()];
  const n = ids.length;
  if (n === 0) return [];
  const pos = new Map<NodeId, number>(ids.map((id, i) => [id, i]));
  // Dense out-target lists once up front — iteration then never touches the store.
  const outs: number[][] = [];
  for (const id of ids) {
    await ticker.tick();
    outs.push(store.outEdges(id).map((e) => pos.get(e.to)!));
  }

  let rank = new Float64Array(n).fill(1 / n);
  for (let iter = 0; iter < iterations; iter++) {
    const next = new Float64Array(n).fill((1 - damping) / n);
    let danglingMass = 0;
    for (let i = 0; i < n; i++) {
      await ticker.tick();
      const targets = outs[i]!;
      if (targets.length === 0) {
        danglingMass += rank[i]!;
        continue;
      }
      const share = (damping * rank[i]!) / targets.length;
      for (const t of targets) next[t]! += share;
    }
    const danglingShare = (damping * danglingMass) / n;
    for (let i = 0; i < n; i++) next[i]! += danglingShare;
    rank = next;
  }
  return ids.map((id, i) => ({ node: id, score: rank[i]! }));
}
