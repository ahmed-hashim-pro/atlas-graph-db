import { describe, expect, it } from 'vitest';
import { GraphStore } from '../src/store.js';

describe('label index', () => {
  it('serves nodesByLabel from the index, including multi-label nodes', () => {
    const s = new GraphStore();
    s.applyOp({ op: 'createNode', id: 1, labels: ['Person', 'Author'], props: {} });
    s.applyOp({ op: 'createNode', id: 2, labels: ['Person'], props: {} });
    expect([...s.nodesByLabel('Person')].map((n) => n.id).sort((a, b) => a - b)).toEqual([1, 2]);
    expect([...s.nodesByLabel('Author')].map((n) => n.id)).toEqual([1]);
    expect(s.labelCount('Person')).toBe(2);
    expect(s.labelCount('Nope')).toBe(0);
    expect([...s.nodeIdsByLabel('Person')].sort((a, b) => a - b)).toEqual([1, 2]);
    expect(s.nodeIdsByLabel('Nope').size).toBe(0);
  });

  it('treats duplicate labels in a node record as a single index entry, not corruption', () => {
    const s = new GraphStore();
    s.applyOp({ op: 'createNode', id: 1, labels: ['A', 'A'], props: {} });
    expect(s.labelCount('A')).toBe(1);
    expect([...s.nodesByLabel('A')].map((n) => n.id)).toEqual([1]);
    expect(() => s.checkInvariants()).not.toThrow();
  });

  it('removes deleted nodes from the index and prunes empty labels', () => {
    const s = new GraphStore();
    s.applyOp({ op: 'createNode', id: 1, labels: ['A'], props: {} });
    s.applyOp({ op: 'deleteNode', id: 1 });
    expect([...s.nodesByLabel('A')]).toEqual([]);
    expect(s.labelCount('A')).toBe(0);
    expect(() => s.checkInvariants()).not.toThrow();
  });
});
