import { describe, expect, it } from 'vitest';
import { AtlasError } from '../src/errors.js';
import { GraphStore } from '../src/store.js';

function pair(): GraphStore {
  const s = new GraphStore();
  s.applyOp({ op: 'createNode', id: 1, labels: ['A'], props: { keep: 1, drop: 2 } });
  s.applyOp({ op: 'createNode', id: 2, labels: ['A'], props: {} });
  s.applyOp({ op: 'createEdge', id: 1, type: 'T', from: 1, to: 2, props: { w: 1 } });
  return s;
}

describe('GraphStore mutations', () => {
  it('merges and removes properties', () => {
    const s = pair();
    s.applyOp({ op: 'setNodeProps', id: 1, set: { added: true }, remove: ['drop'] });
    expect(s.getNode(1)?.props).toEqual({ keep: 1, added: true });
    s.applyOp({ op: 'setEdgeProps', id: 1, set: { w: 2 }, remove: [] });
    expect(s.getEdge(1)?.props).toEqual({ w: 2 });
  });

  it('deleteEdge clears adjacency on both sides', () => {
    const s = pair();
    s.applyOp({ op: 'deleteEdge', id: 1 });
    expect(s.getEdge(1)).toBeUndefined();
    expect(s.outEdges(1)).toEqual([]);
    expect(s.inEdges(2)).toEqual([]);
    expect(() => s.checkInvariants()).not.toThrow();
  });

  it('deleteNode refuses while edges remain, succeeds after', () => {
    const s = pair();
    expect(() => s.applyOp({ op: 'deleteNode', id: 1 })).toThrowError(AtlasError);
    s.applyOp({ op: 'deleteEdge', id: 1 });
    s.applyOp({ op: 'deleteNode', id: 1 });
    expect(s.getNode(1)).toBeUndefined();
    expect(s.stats()).toEqual({ nodeCount: 1, edgeCount: 0 });
  });
});
