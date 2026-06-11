import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BTree } from '../src/index/btree.js';
import { compareValues, type ScalarValue } from '../src/index/keys.js';

function entries(t: BTree, q: Parameters<BTree['range']>[0] = {}): [ScalarValue, number][] {
  return [...t.range(q)];
}

type Pair = [ScalarValue, number];

interface ProbeLeaf {
  leaf: true;
  keys: ScalarValue[];
  ids: number[];
}
interface ProbeInternal {
  leaf: false;
  keys: ScalarValue[];
  splitIds: number[];
  children: ProbeTreeNode[];
}
type ProbeTreeNode = ProbeLeaf | ProbeInternal;

function probeRoot(t: BTree): ProbeTreeNode {
  return (t as unknown as { root: ProbeTreeNode }).root;
}

/**
 * Walk the private root to measure tree depth. Used to prove the deep-tree
 * tests actually reach internal-node splits (depth >= 3 means the root split
 * produced internal children, which with ORDER = 64 needs > 64 leaves).
 */
function depth(t: BTree): number {
  let n = probeRoot(t);
  let d = 1;
  while (!n.leaf) {
    d++;
    n = n.children[0]!;
  }
  return d;
}

/**
 * Assert the internal-split bookkeeping invariants on every node: keys and
 * splitIds are parallel arrays with fanout keys.length + 1, and each split
 * pair strictly separates adjacent child subtrees by (key, id). Catches
 * regressions the public API cannot observe (e.g. dropping the
 * splitIds.pop() that mirrors keys.pop() in the internal split).
 */
function checkStructure(t: BTree): void {
  const cmp = (a: Pair, b: Pair): number => compareValues(a[0], b[0]) || a[1] - b[1];
  // Returns the [min, max] (key, id) span of the subtree, or null when empty
  // (removal never rebalances, so leaves may drain entirely).
  const visit = (n: ProbeTreeNode): [Pair, Pair] | null => {
    if (n.leaf) {
      expect(n.ids.length).toBe(n.keys.length);
      if (n.keys.length === 0) return null;
      return [
        [n.keys[0]!, n.ids[0]!],
        [n.keys[n.keys.length - 1]!, n.ids[n.ids.length - 1]!],
      ];
    }
    expect(n.splitIds.length).toBe(n.keys.length);
    expect(n.children.length).toBe(n.keys.length + 1);
    let min: Pair | null = null;
    let max: Pair | null = null;
    for (let i = 0; i < n.children.length; i++) {
      const span = visit(n.children[i]!);
      if (!span) continue;
      // Child i sits strictly below split pair i and at/above split pair i-1.
      if (i < n.keys.length) {
        expect(cmp(span[1], [n.keys[i]!, n.splitIds[i]!])).toBeLessThan(0);
      }
      if (i > 0) {
        expect(cmp(span[0], [n.keys[i - 1]!, n.splitIds[i - 1]!])).toBeGreaterThanOrEqual(0);
      }
      min ??= span[0];
      max = span[1];
    }
    return min && max ? [min, max] : null;
  };
  visit(probeRoot(t));
}

describe('BTree basics', () => {
  it('inserts, iterates in order, and supports duplicate keys', () => {
    const t = new BTree();
    t.insert(5, 50);
    t.insert(1, 10);
    t.insert(5, 51);
    t.insert(3, 30);
    expect(entries(t)).toEqual([
      [1, 10],
      [3, 30],
      [5, 50],
      [5, 51],
    ]);
    expect(t.size).toBe(4);
  });

  it('range respects gt/gte/lt/lte bounds', () => {
    const t = new BTree();
    for (let i = 1; i <= 9; i++) t.insert(i, i * 10);
    expect(entries(t, { gte: 3, lte: 5 }).map(([k]) => k)).toEqual([3, 4, 5]);
    expect(entries(t, { gt: 3, lt: 5 }).map(([k]) => k)).toEqual([4]);
    expect(entries(t, { gte: 8 }).map(([k]) => k)).toEqual([8, 9]);
    expect(entries(t, { lt: 2 }).map(([k]) => k)).toEqual([1]);
  });

  it('removes exactly the (key, id) pair', () => {
    const t = new BTree();
    t.insert(5, 50);
    t.insert(5, 51);
    expect(t.remove(5, 50)).toBe(true);
    expect(t.remove(5, 99)).toBe(false);
    expect(entries(t)).toEqual([[5, 51]]);
  });

  it('orders mixed types by type rank', () => {
    const t = new BTree();
    t.insert('a', 1);
    t.insert(7, 2);
    t.insert(true, 3);
    expect(entries(t).map(([k]) => k)).toEqual([7, 'a', true]);
  });
});

describe('BTree deep trees (internal-node splits)', () => {
  // The property test caps at 600 live entries, but with ORDER = 64 an
  // internal-node split needs > 64 leaf children (~2080+ entries). These
  // deterministic tests are the only coverage of the internal-split
  // bookkeeping in insertInto (midIdx, the splice(midIdx + 1) calls, and the
  // upKey/upId pops).
  it('stays consistent at depth >= 3 under mixed-order inserts and bulk removal', () => {
    const t = new BTree();
    const model: [number, number][] = [];
    // Park-Miller LCG: deterministic mixed-order keys with duplicates.
    let seed = 123456789;
    const next = (): number => (seed = (seed * 48271) % 2147483647);
    const N = 8000;
    for (let id = 0; id < N; id++) {
      const key = next() % 1000;
      t.insert(key, id);
      model.push([key, id]);
    }
    expect(depth(t)).toBeGreaterThanOrEqual(3);
    checkStructure(t);
    expect(t.size).toBe(N);
    model.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    expect(entries(t)).toEqual(model);
    expect(entries(t, { gte: 250, lte: 750 })).toEqual(model.filter(([k]) => k >= 250 && k <= 750));

    // Remove a large subset, then re-verify iteration, range, and size.
    for (const [k, id] of model) {
      if (id % 3 === 0) expect(t.remove(k, id)).toBe(true);
    }
    const remaining = model.filter(([, id]) => id % 3 !== 0);
    checkStructure(t);
    expect(t.size).toBe(remaining.length);
    expect(entries(t)).toEqual(remaining);
    expect(entries(t, { gte: 250, lte: 750 })).toEqual(
      remaining.filter(([k]) => k >= 250 && k <= 750),
    );
  });

  it('stays consistent at depth >= 3 under sequential ascending and descending inserts', () => {
    const asc = new BTree();
    const desc = new BTree();
    const N = 5000;
    for (let i = 0; i < N; i++) {
      asc.insert(i, i);
      desc.insert(N - 1 - i, N - 1 - i);
    }
    const want: [number, number][] = Array.from({ length: N }, (_, i) => [i, i]);
    for (const t of [asc, desc]) {
      expect(depth(t)).toBeGreaterThanOrEqual(3);
      checkStructure(t);
      expect(t.size).toBe(N);
      expect(entries(t)).toEqual(want);
      expect(entries(t, { gt: 1000, lt: 1005 }).map(([k]) => k)).toEqual([1001, 1002, 1003, 1004]);
    }
  });

  it('handles duplicate runs that straddle leaf splits (split pairs carry ids)', () => {
    // A single key with 200 ids spans multiple leaves, so the split pairs
    // inside the run differ only by id — the reason Internal carries splitIds.
    // Routing remove() to the right leaf must use the full (key, id) pair.
    const t = new BTree();
    t.insert(10, 0);
    t.insert(30, 0);
    const RUN = 200;
    for (let id = 0; id < RUN; id++) t.insert(20, id);
    expect(t.size).toBe(RUN + 2);

    // Remove pairs from the middle of the run.
    for (let id = 80; id < 120; id++) expect(t.remove(20, id)).toBe(true);
    expect(t.remove(20, 999)).toBe(false);

    const wantIds = Array.from({ length: RUN }, (_, id) => id).filter((id) => id < 80 || id >= 120);
    expect(entries(t, { gte: 20, lte: 20 }).map(([, id]) => id)).toEqual(wantIds);
    checkStructure(t);
    expect(t.size).toBe(wantIds.length + 2);
    expect(entries(t).map(([k]) => k)).toEqual([10, ...wantIds.map(() => 20), 30]);
  });
});

describe('BTree vs reference model (property)', () => {
  it('matches a sorted-array model under random insert/remove/range at splitting sizes', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            kind: fc.constantFrom('insert', 'remove'),
            key: fc.integer({ min: 0, max: 200 }),
            id: fc.integer({ min: 0, max: 20 }),
          }),
          { minLength: 200, maxLength: 600 },
        ),
        fc.record({ lo: fc.integer({ min: 0, max: 200 }), hi: fc.integer({ min: 0, max: 200 }) }),
        (actions, bounds) => {
          const t = new BTree();
          const model: [number, number][] = [];
          for (const a of actions) {
            if (a.kind === 'insert') {
              const dup = model.some(([k, i]) => k === a.key && i === a.id);
              if (!dup) {
                t.insert(a.key, a.id);
                model.push([a.key, a.id]);
              }
            } else {
              const idx = model.findIndex(([k, i]) => k === a.key && i === a.id);
              expect(t.remove(a.key, a.id)).toBe(idx !== -1);
              if (idx !== -1) model.splice(idx, 1);
            }
          }
          model.sort((x, y) => compareValues(x[0], y[0]) || x[1] - y[1]);
          expect(entries(t)).toEqual(model);
          const [lo, hi] = bounds.lo <= bounds.hi ? [bounds.lo, bounds.hi] : [bounds.hi, bounds.lo];
          expect(entries(t, { gte: lo, lte: hi })).toEqual(
            model.filter(([k]) => k >= lo && k <= hi),
          );
          expect(t.size).toBe(model.length);
        },
      ),
      { numRuns: 40 },
    );
  }, 60_000);
});
