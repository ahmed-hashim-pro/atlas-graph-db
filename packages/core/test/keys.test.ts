import { describe, expect, it } from 'vitest';
import { compareValues, encodeKey, isScalar, typeRank } from '../src/index/keys.js';

describe('keys', () => {
  it('isScalar accepts primitives and Dates, rejects arrays', () => {
    expect(isScalar('x')).toBe(true);
    expect(isScalar(3)).toBe(true);
    expect(isScalar(false)).toBe(true);
    expect(isScalar(new Date(0))).toBe(true);
    expect(isScalar(['x'])).toBe(false);
  });

  it('encodeKey distinguishes equal-looking values of different types', () => {
    expect(encodeKey(1)).not.toBe(encodeKey('1'));
    expect(encodeKey(true)).not.toBe(encodeKey('true'));
    expect(encodeKey(new Date(5))).not.toBe(encodeKey(5));
    expect(encodeKey(1)).toBe(encodeKey(1));
  });

  it('compareValues orders within a type and ranks across types', () => {
    expect(compareValues(1, 2)).toBeLessThan(0);
    expect(compareValues('b', 'a')).toBeGreaterThan(0);
    expect(compareValues(false, true)).toBeLessThan(0);
    expect(compareValues(new Date(1), new Date(2))).toBeLessThan(0);
    expect(compareValues(99, 'a')).toBeLessThan(0); // number ranks before string
    expect(typeRank(true)).toBeGreaterThan(typeRank('s'));
  });
});
