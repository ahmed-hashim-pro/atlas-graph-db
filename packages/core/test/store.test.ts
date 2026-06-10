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

  it('detects a missing in-adjacency entry (white-box)', () => {
    const s = seeded();
    // Edge 2 is WROTE (1 -> 3). Remove only its in-side entry to simulate a half-lost index.
    const inAdj = (s as unknown as { inAdj: Map<number, Map<number, Set<number>>> }).inAdj;
    const typeId = s.types.idOf('WROTE')!;
    inAdj.get(3)!.get(typeId)!.delete(2);
    expect(() => s.checkInvariants()).toThrowError(AtlasError);
    expect(() => s.checkInvariants()).toThrowError(/in-adjacency covers 1 edges, store has 2/);
  });

  it('detects a missing out-adjacency entry (white-box)', () => {
    const s = seeded();
    const outAdj = (s as unknown as { outAdj: Map<number, Map<number, Set<number>>> }).outAdj;
    const typeId = s.types.idOf('KNOWS')!;
    outAdj.get(1)!.get(typeId)!.delete(1);
    expect(() => s.checkInvariants()).toThrowError(/out-adjacency covers 1 edges, store has 2/);
  });

  it('deleteEdge keeps invariants and prunes empty adjacency buckets', () => {
    const s = seeded();
    s.applyOp({ op: 'deleteEdge', id: 1 });
    expect(s.getEdge(1)).toBeUndefined();
    expect(s.outEdges(1, 'KNOWS')).toEqual([]);
    expect(s.inEdges(2)).toEqual([]);
    expect(() => s.checkInvariants()).not.toThrow();
    // White-box: empty Set/Map buckets must be pruned, not left behind.
    const { outAdj, inAdj } = s as unknown as {
      outAdj: Map<number, Map<number, Set<number>>>;
      inAdj: Map<number, Map<number, Set<number>>>;
    };
    expect(outAdj.get(1)?.get(s.types.idOf('KNOWS')!)).toBeUndefined();
    expect(inAdj.has(2)).toBe(false);
    // Node 1 still has an outgoing WROTE edge, so its out map stays.
    expect(outAdj.get(1)?.size).toBe(1);
    s.applyOp({ op: 'deleteEdge', id: 2 });
    expect(outAdj.has(1)).toBe(false);
    expect(inAdj.has(3)).toBe(false);
    expect(() => s.checkInvariants()).not.toThrow();
    expect(s.stats()).toEqual({ nodeCount: 3, edgeCount: 0 });
  });

  it('deleteEdge throws INTERNAL if the edge type was never interned (white-box)', () => {
    const s = seeded();
    // Corrupt the record's type to one that idOf cannot resolve.
    s.getEdge(1)!.type = 'NEVER_INTERNED';
    expect(() => s.applyOp({ op: 'deleteEdge', id: 1 })).toThrowError(AtlasError);
    expect(() => s.applyOp({ op: 'deleteEdge', id: 1 })).toThrowError(/not interned for edge 1/);
  });
});
