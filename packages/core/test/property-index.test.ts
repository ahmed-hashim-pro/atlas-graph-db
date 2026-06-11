import { describe, expect, it } from 'vitest';
import { PropertyIndex } from '../src/index/property-index.js';

describe('PropertyIndex', () => {
  it('answers exact lookups, distinguishing value types', () => {
    const ix = new PropertyIndex();
    ix.add(1815, 1);
    ix.add('1815', 2);
    ix.add(1815, 3);
    expect([...(ix.getExact(1815) ?? [])].sort()).toEqual([1, 3]);
    expect([...(ix.getExact('1815') ?? [])]).toEqual([2]);
    expect(ix.getExact(9999)).toBeUndefined();
  });

  it('answers range queries in order', () => {
    const ix = new PropertyIndex();
    ix.add(1809, 1); // Darwin
    ix.add(1815, 2); // Lovelace
    ix.add(1791, 3); // Babbage
    ix.add(1867, 4); // Curie
    expect([...ix.getRange({ gte: 1800, lt: 1867 })]).toEqual([1, 2]);
    expect([...ix.getRange({ gt: 1815 })]).toEqual([4]);
  });

  it('removes ids and ignores non-scalar values entirely', () => {
    const ix = new PropertyIndex();
    ix.add(['tag'], 1); // arrays are not indexable — silently skipped
    expect(ix.size).toBe(0);
    ix.add(5, 2);
    ix.remove(5, 2);
    expect(ix.getExact(5)).toBeUndefined();
    expect([...ix.getRange({})]).toEqual([]);
    expect(ix.size).toBe(0);
  });
});
