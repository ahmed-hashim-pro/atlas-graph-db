import type { GraphStore } from '../store.js';
import type { NodeId } from '../types.js';
import { neighbors, type Ticker } from './runner.js';

export interface ComponentsOptions {
  mode?: 'weak' | 'strong';
}

export async function components(
  store: GraphStore,
  ticker: Ticker,
  opts: ComponentsOptions = {},
): Promise<{ node: NodeId; component: number }[]> {
  return (opts.mode ?? 'weak') === 'weak' ? weak(store, ticker) : strong(store, ticker);
}

async function weak(store: GraphStore, ticker: Ticker): Promise<{ node: NodeId; component: number }[]> {
  const assigned = new Map<NodeId, number>();
  let comp = 0;
  for (const root of store.nodes.keys()) {
    if (assigned.has(root)) continue;
    const queue: NodeId[] = [root];
    assigned.set(root, comp);
    while (queue.length > 0) {
      const id = queue.pop()!;
      await ticker.tick();
      for (const { next } of neighbors(store, id, 'both')) {
        if (assigned.has(next)) continue;
        assigned.set(next, comp);
        queue.push(next);
      }
    }
    comp++;
  }
  return [...assigned].map(([node, component]) => ({ node, component }));
}

/** Iterative Tarjan — explicit frames, no recursion (1M-node graphs would blow the call stack). */
async function strong(store: GraphStore, ticker: Ticker): Promise<{ node: NodeId; component: number }[]> {
  const index = new Map<NodeId, number>();
  const low = new Map<NodeId, number>();
  const onStack = new Set<NodeId>();
  const stack: NodeId[] = [];
  const result = new Map<NodeId, number>();
  let nextIndex = 0;
  let comp = 0;

  interface Frame {
    id: NodeId;
    iter: Iterator<{ next: NodeId }>;
  }

  for (const root of store.nodes.keys()) {
    if (index.has(root)) continue;
    index.set(root, nextIndex);
    low.set(root, nextIndex);
    nextIndex++;
    stack.push(root);
    onStack.add(root);
    const frames: Frame[] = [{ id: root, iter: neighbors(store, root, 'out') }];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const step = frame.iter.next();
      if (!step.done) {
        await ticker.tick();
        const w = step.value.next;
        if (!index.has(w)) {
          index.set(w, nextIndex);
          low.set(w, nextIndex);
          nextIndex++;
          stack.push(w);
          onStack.add(w);
          frames.push({ id: w, iter: neighbors(store, w, 'out') });
        } else if (onStack.has(w)) {
          low.set(frame.id, Math.min(low.get(frame.id)!, index.get(w)!));
        }
      } else {
        frames.pop();
        if (low.get(frame.id) === index.get(frame.id)) {
          for (;;) {
            const w = stack.pop()!;
            onStack.delete(w);
            result.set(w, comp);
            if (w === frame.id) break;
          }
          comp++;
        }
        const parent = frames[frames.length - 1];
        if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
      }
    }
  }
  return [...result].map(([node, component]) => ({ node, component }));
}
