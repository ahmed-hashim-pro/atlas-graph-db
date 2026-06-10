import { describe, expect, it } from 'vitest';
import { AtlasError } from '../src/errors.js';
import { validateProps } from '../src/types.js';

describe('validateProps', () => {
  it('accepts primitives, Dates, and homogeneous arrays', () => {
    expect(() =>
      validateProps({
        name: 'Ada',
        born: 1815,
        active: true,
        when: new Date(0),
        tags: ['a', 'b'],
        scores: [1, 2.5],
      }),
    ).not.toThrow();
  });

  it.each([
    ['nested object', { x: { y: 1 } }],
    ['null', { x: null }],
    ['undefined', { x: undefined }],
    ['NaN', { x: Number.NaN }],
    ['Infinity', { x: Infinity }],
    ['mixed array', { x: [1, 'a'] }],
    ['empty key', { '': 1 }],
  ])('rejects %s with VALIDATION', (_name, props) => {
    try {
      validateProps(props as never);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AtlasError);
      expect((e as AtlasError).code).toBe('VALIDATION');
    }
  });
});
