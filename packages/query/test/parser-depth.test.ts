import { describe, expect, it } from 'vitest';
import { AqlError } from '../src/errors.js';
import { parseQuery } from '../src/parser.js';

describe('parseQuery — expression depth cap', () => {
  const codeOf = (src: string): string => {
    try {
      parseQuery(src);
    } catch (e) {
      expect(e).toBeInstanceOf(AqlError);
      return (e as AqlError).code;
    }
    throw new Error('expected parseQuery to throw');
  };

  it('caps deeply nested parens with PARSE_ERROR (not RangeError)', () => {
    const src = 'MATCH (n) WHERE ' + '('.repeat(2000) + 'n.x = 1' + ')'.repeat(2000) + ' RETURN n';
    expect(codeOf(src)).toBe('PARSE_ERROR');
  });

  it('caps a very long AND chain with PARSE_ERROR (not RangeError)', () => {
    const conjuncts = Array.from({ length: 20000 }, () => 'n.x = 1').join(' AND ');
    const src = `MATCH (n) WHERE ${conjuncts} RETURN n`;
    expect(codeOf(src)).toBe('PARSE_ERROR');
  });
});
