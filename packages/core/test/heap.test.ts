import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MinHeap } from '../src/algo/heap.js';

describe('MinHeap', () => {
  it('pops in ascending key order', () => {
    const h = new MinHeap<string>();
    h.push(5, 'five');
    h.push(1, 'one');
    h.push(3, 'three');
    expect(h.pop()).toEqual({ key: 1, value: 'one' });
    expect(h.pop()).toEqual({ key: 3, value: 'three' });
    expect(h.pop()).toEqual({ key: 5, value: 'five' });
    expect(h.pop()).toBeUndefined();
    expect(h.size).toBe(0);
  });

  it('matches a sorted reference under random pushes (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -1000, max: 1000 }), { maxLength: 300 }), (keys) => {
        const h = new MinHeap<number>();
        for (const k of keys) h.push(k, k);
        const out: number[] = [];
        for (let p = h.pop(); p !== undefined; p = h.pop()) out.push(p.key);
        expect(out).toEqual([...keys].sort((a, b) => a - b));
      }),
    );
  });
});
