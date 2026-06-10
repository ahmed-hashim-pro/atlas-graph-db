import { describe, expect, it } from 'vitest';
import { AtlasError } from '../src/errors.js';
import { GraphStore } from '../src/store.js';

function seeded(): GraphStore {
  const s = new GraphStore();
  s.applyOp({ op: 'createNode', id: 1, labels: ['Person'], props: { name: 'Ada' } });
  s.applyOp({ op: 'createNode', id: 2, labels: ['Person'], props: { name: 'Charles' } });
  s.applyOp({ op: 'createNode', id: 3, labels: ['Document'], props: { title: 'Notes' } });
  s.applyOp({ op: 'createEdge', id: 1, type: 'KNOWS', from: 1, to: 2, props: {} });
  s.applyOp({ op: 'createEdge', id: 2, type: 'WROTE', from: 1, to: 3, props: {} });
  return s;
}

describe('GraphStore creation + adjacency', () => {
  it('stores nodes and edges and answers typed adjacency both ways', () => {
    const s = seeded();
    expect(s.getNode(1)?.props.name).toBe('Ada');
    expect(s.getEdge(2)?.type).toBe('WROTE');
    expect(
      s
        .outEdges(1)
        .map((e) => e.id)
        .sort(),
    ).toEqual([1, 2]);
    expect(s.outEdges(1, 'KNOWS').map((e) => e.id)).toEqual([1]);
    expect(s.inEdges(3, 'WROTE').map((e) => e.id)).toEqual([2]);
    expect(s.inEdges(3, 'KNOWS')).toEqual([]);
    expect(s.stats()).toEqual({ nodeCount: 3, edgeCount: 2 });
  });

  it('scans nodes by label', () => {
    const s = seeded();
    expect([...s.nodesByLabel('Person')].map((n) => n.id).sort()).toEqual([1, 2]);
    expect([...s.nodesByLabel('Nope')]).toEqual([]);
  });

  it('rejects duplicate ids and dangling endpoints with INTERNAL', () => {
    const s = seeded();
    expect(() => s.applyOp({ op: 'createNode', id: 1, labels: ['X'], props: {} })).toThrowError(
      AtlasError,
    );
    expect(() =>
      s.applyOp({ op: 'createEdge', id: 9, type: 'KNOWS', from: 1, to: 99, props: {} }),
    ).toThrowError(AtlasError);
  });

  it('passes invariant checks on a healthy store', () => {
    expect(() => seeded().checkInvariants()).not.toThrow();
  });
});
