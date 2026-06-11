import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BTree } from '../src/index/btree.js';
import { compareValues, type ScalarValue } from '../src/index/keys.js';

function entries(t: BTree, q: Parameters<BTree['range']>[0] = {}): [ScalarValue, number][] {
  return [...t.range(q)];
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
