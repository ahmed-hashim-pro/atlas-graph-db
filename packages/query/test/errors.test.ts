import { describe, expect, it } from 'vitest';
import { AqlError, renderSnippet } from '../src/errors.js';

describe('renderSnippet', () => {
  it('renders the offending line with a caret under the column', () => {
    const src = 'MATCH (p:Person)\nWHERE p.born >> 1800\nRETURN p';
    expect(renderSnippet(src, 2, 14)).toBe('WHERE p.born >> 1800\n             ^');
  });

  it('clamps out-of-range positions instead of throwing', () => {
    expect(renderSnippet('RETURN 1', 99, 99)).toBe('RETURN 1\n        ^');
  });
});

describe('AqlError', () => {
  it('carries code, message, position, and a built snippet', () => {
    const e = new AqlError(
      'PARSE_ERROR',
      'unexpected token ">>"',
      { line: 2, column: 14 },
      'MATCH (p)\nWHERE p.x >> 1\nRETURN p',
    );
    expect(e.code).toBe('PARSE_ERROR');
    expect(e.line).toBe(2);
    expect(e.column).toBe(14);
    expect(e.snippet).toContain('^');
    expect(e.name).toBe('AqlError');
  });
});
