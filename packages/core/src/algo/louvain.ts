import type { GraphStore } from '../store.js';
import type { NodeId } from '../types.js';
import type { Ticker } from './runner.js';

export interface LouvainOptions {
  maxLevels?: number;
}

interface Level {
  adj: Map<number, number>[]; // neighbor -> accumulated weight (undirected, no self entries)
  selfW: Float64Array; // self-loop weight, doubled per convention
}

export async function louvain(
  store: GraphStore,
  ticker: Ticker,
  opts: LouvainOptions = {},
): Promise<{ node: NodeId; community: number }[]> {
  const maxLevels = opts.maxLevels ?? 10;
  const ids = [...store.nodes.keys()];
  const n = ids.length;
  if (n === 0) return [];
  const pos = new Map<NodeId, number>(ids.map((id, i) => [id, i]));

  let level: Level = {
    adj: Array.from({ length: n }, () => new Map()),
    selfW: new Float64Array(n),
  };
  let m2 = 0; // total weight x2
  for (const e of store.edges.values()) {
    await ticker.tick();
    const a = pos.get(e.from)!;
    const b = pos.get(e.to)!;
    m2 += 2;
    if (a === b) {
      level.selfW[a]! += 2;
      continue;
    }
    level.adj[a]!.set(b, (level.adj[a]!.get(b) ?? 0) + 1);
    level.adj[b]!.set(a, (level.adj[b]!.get(a) ?? 0) + 1);
  }
  if (m2 === 0) return ids.map((id, i) => ({ node: id, community: i }));

  let mapping = ids.map((_, i) => i); // original index -> current-level node
  for (let l = 0; l < maxLevels; l++) {
    const { communities, moved } = await localMove(level, m2, ticker);
    mapping = mapping.map((cur) => communities[cur]!);
    if (!moved) break;
    const prevN = level.adj.length;
    const k = Math.max(...communities) + 1;
    const next: Level = {
      adj: Array.from({ length: k }, () => new Map()),
      selfW: new Float64Array(k),
    };
    for (let v = 0; v < prevN; v++) {
      await ticker.tick();
      const cv = communities[v]!;
      next.selfW[cv]! += level.selfW[v]!;
      for (const [w, wt] of level.adj[v]!) {
        const cw = communities[w]!;
        if (cv === cw)
          next.selfW[cv]! += wt; // both directions land here -> doubled, as required
        else next.adj[cv]!.set(cw, (next.adj[cv]!.get(cw) ?? 0) + wt);
      }
    }
    level = next;
    if (k === prevN) break; // no aggregation progress
  }
  return ids.map((id, i) => ({ node: id, community: mapping[i]! }));
}

async function localMove(
  level: Level,
  m2: number,
  ticker: Ticker,
): Promise<{ communities: number[]; moved: boolean }> {
  const n = level.adj.length;
  const comm = Array.from({ length: n }, (_, i) => i);
  const degree = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let d = level.selfW[i]!;
    for (const wt of level.adj[i]!.values()) d += wt;
    degree[i] = d;
  }
  const commTot = Float64Array.from(degree);
  let movedAny = false;
  let improved = true;
  while (improved) {
    improved = false;
    for (let v = 0; v < n; v++) {
      await ticker.tick();
      const cv = comm[v]!;
      const links = new Map<number, number>();
      for (const [w, wt] of level.adj[v]!) {
        const cw = comm[w]!;
        links.set(cw, (links.get(cw) ?? 0) + wt);
      }
      commTot[cv]! -= degree[v]!;
      let bestC = cv;
      let bestScore = (links.get(cv) ?? 0) - (degree[v]! * commTot[cv]!) / m2;
      for (const [c, lw] of links) {
        if (c === cv) continue;
        const score = lw - (degree[v]! * commTot[c]!) / m2;
        if (score > bestScore + 1e-12) {
          bestScore = score;
          bestC = c;
        }
      }
      commTot[bestC]! += degree[v]!;
      if (bestC !== cv) {
        comm[v] = bestC;
        movedAny = true;
        improved = true;
      }
    }
  }
  const renumber = new Map<number, number>();
  const communities = comm.map((c) => {
    let r = renumber.get(c);
    if (r === undefined) {
      r = renumber.size;
      renumber.set(c, r);
    }
    return r;
  });
  return { communities, moved: movedAny };
}
