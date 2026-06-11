import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ScalarValue } from '../src/index/keys.js';
import { compareValues, encodeKey, isScalar, typeRank } from '../src/index/keys.js';

describe('keys', () => {
  it('isScalar accepts primitives and Dates, rejects arrays', () => {
    expect(isScalar('x')).toBe(true);
    expect(isScalar(3)).toBe(true);
    expect(isScalar(false)).toBe(true);
    expect(isScalar(new Date(0))).toBe(true);
    expect(isScalar(['x'])).toBe(false);
  });

  it('isScalar rejects invalid Dates so they are never indexed', () => {
    expect(isScalar(new Date('garbage'))).toBe(false);
    expect(isScalar(new Date(Number.NaN))).toBe(false);
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
    expect(compareValues(true, new Date(0))).toBeLessThan(0); // boolean ranks before date
    expect(typeRank(true)).toBeGreaterThan(typeRank('s'));
  });

  it('compareValues is reflexive for every type', () => {
    expect(compareValues(7, 7)).toBe(0);
    expect(compareValues('abc', 'abc')).toBe(0);
    expect(compareValues(true, true)).toBe(0);
    expect(compareValues(new Date(42), new Date(42))).toBe(0);
  });

  describe('comparator laws (property-based)', () => {
    const scalarArb: fc.Arbitrary<ScalarValue> = fc.oneof(
      fc.double({ noNaN: true, noDefaultInfinity: true }),
      fc.string(),
      fc.boolean(),
      fc.date({ noInvalidDate: true }),
    );

    it('reflexivity: compareValues(x, x) === 0', () => {
      fc.assert(
        fc.property(scalarArb, (x) => {
          expect(compareValues(x, x)).toBe(0);
        }),
      );
    });

    it('sign-antisymmetry: sign(compare(a, b)) === -sign(compare(b, a))', () => {
      fc.assert(
        fc.property(scalarArb, scalarArb, (a, b) => {
          // Expressed as a sum to avoid Object.is(0, -0) failures in toBe.
          expect(Math.sign(compareValues(a, b)) + Math.sign(compareValues(b, a))).toBe(0);
        }),
      );
    });

    it('transitivity: a <= b and b <= c implies a <= c', () => {
      fc.assert(
        fc.property(scalarArb, scalarArb, scalarArb, (a, b, c) => {
          if (compareValues(a, b) <= 0 && compareValues(b, c) <= 0) {
            expect(compareValues(a, c)).toBeLessThanOrEqual(0);
          }
        }),
      );
    });

    it('encodeKey(a) === encodeKey(b) iff compareValues(a, b) === 0', () => {
      fc.assert(
        fc.property(scalarArb, scalarArb, (a, b) => {
          expect(encodeKey(a) === encodeKey(b)).toBe(compareValues(a, b) === 0);
        }),
      );
    });
  });
});
