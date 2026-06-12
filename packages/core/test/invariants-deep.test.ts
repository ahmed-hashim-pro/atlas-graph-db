import { describe, expect, it } from 'vitest';
import { GraphStore } from '../src/store.js';
import type { NodeId } from '../src/types.js';

function seeded(): GraphStore {
  const s = new GraphStore();
  s.applyOp({ op: 'createIndex', def: { kind: 'property', label: 'P', property: 'v' } });
  s.applyOp({ op: 'createIndex', def: { kind: 'fulltext', label: 'P', property: 'text' } });
  s.applyOp({ op: 'createIndex', def: { kind: 'unique', label: 'P', property: 'u' } });
  s.applyOp({ op: 'createNode', id: 1, labels: ['P'], props: { v: 5, text: 'graph theory', u: 'a' } });
  s.applyOp({ op: 'createNode', id: 2, labels: ['P'], props: { v: 7, text: 'graph algebra', u: 'b' } });
  s.applyOp({ op: 'createEdge', id: 1, type: 'T', from: 1, to: 2, props: {} });
  return s;
}

describe('deep invariants', () => {
  it('pass on a healthy store with all index kinds populated', () => {
    expect(() => seeded().checkInvariants()).not.toThrow();
  });

  it('pass after mutations that exercise the maintenance hooks', () => {
    const s = seeded();
    s.applyOp({ op: 'setNodeProps', id: 1, set: { v: 9, text: 'lattice theory' }, remove: ['u'] });
    s.applyOp({ op: 'deleteEdge', id: 1 });
    s.applyOp({ op: 'deleteNode', id: 2 });
    expect(() => s.checkInvariants()).not.toThrow();
  });

  it('catch a property-index posting desync', () => {
    const s = seeded();
    const set = s.indexes.lookupExact('P', 'v', 5) as Set<NodeId>;
    set.delete(1); // simulate a hook bug corrupting the live posting
    expect(() => s.checkInvariants()).toThrow(/index/);
  });

  it('catch a fulltext posting desync', () => {
    const s = seeded();
    // Remove a value the node still carries — postings now disagree with the store.
    s.indexes.searchText('P', 'text', 'graph'); // sanity: token exists
    const entries = [...s.indexes.defs()];
    expect(entries.some((d) => d.kind === 'fulltext')).toBe(true);
    // Corrupt via the maintenance API itself: double-remove leaves postings short.
    s.indexes.beforeApply(
      { op: 'setNodeProps', id: 2, set: {}, remove: ['text'] },
      s,
    );
    expect(() => s.checkInvariants()).toThrow(/fulltext|index/);
  });

  it('catch a schema counter desync', () => {
    const s = seeded();
    // Fire a hook for a node the store never applied — counters drift from reality.
    s.schema.beforeApply({ op: 'createNode', id: 99, labels: ['P'], props: { v: 1 } }, s);
    expect(() => s.checkInvariants()).toThrow(/schema/);
  });
});
