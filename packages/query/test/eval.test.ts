import type { NodeRecord } from '@atlas/core';
import { describe, expect, it } from 'vitest';
import { AqlError } from '../src/errors.js';
import { evalExpr, type Binding } from '../src/eval.js';
import { lex } from '../src/lexer.js';
import { TokenStream, parseExpression } from '../src/parser.js';

const ada: NodeRecord = {
  id: 1,
  labels: ['Person'],
  props: { name: 'Ada', born: 1815, tags: ['math'] },
};
const blank: NodeRecord = { id: 2, labels: ['Person'], props: {} };

function run(src: string, binding: Binding = new Map([['p', ada]]), params = {}): unknown {
  const expr = parseExpression(new TokenStream(lex(src), src));
  return evalExpr(expr, binding, { params, source: src });
}

describe('evalExpr', () => {
  it('evaluates props, comparisons, and boolean logic', () => {
    expect(run("p.name = 'Ada'")).toBe(true);
    expect(run('p.born > 1800 AND p.born < 1820')).toBe(true);
    expect(run("p.name = 'Ada' OR p.born = 0")).toBe(true);
    expect(run('NOT p.born = 1815')).toBe(false);
  });

  it('null/missing props make comparisons false, EXISTS distinguishes', () => {
    const b: Binding = new Map([['p', blank]]);
    expect(run('p.born > 1800', b)).toBe(false);
    expect(run('p.born < 1800', b)).toBe(false);
    expect(run('p.born = NULL', b)).toBe(false); // strict v1: null never equals
    expect(run('NOT p.born > 1800', b)).toBe(true); // NOT of non-true
    expect(run('EXISTS(p.born)', b)).toBe(false);
    expect(run('EXISTS(p.born)')).toBe(true);
  });

  it('equality is type-strict; dates compare by epoch; text ops are string-only', () => {
    expect(run("p.born = '1815'")).toBe(false);
    expect(run("p.name CONTAINS 'd'")).toBe(true);
    expect(run("p.born CONTAINS '8'")).toBe(false);
    expect(run("p.name STARTS WITH 'A'")).toBe(true);
    expect(run("p.name ENDS WITH 'a'")).toBe(true);
  });

  it('IN works over list literals and array params', () => {
    expect(run('p.born IN [1815, 1816]')).toBe(true);
    expect(run('p.born IN $years', undefined, { years: [1815] })).toBe(true);
    expect(run('p.born IN $years', undefined, { years: [9] })).toBe(false);
    expect(run('p.born IN p.name')).toBe(false); // non-array haystack
  });

  it('scalar functions: id, labels, type', () => {
    expect(run('id(p)')).toBe(1);
    expect(run('labels(p)')).toEqual(['Person']);
  });

  it('lower() lowercases a string argument', () => {
    // Build via the parser so we exercise the real call-Expr shape.
    const e = parseExpression(
      new TokenStream(lex("lower('AdA LoVeLaCe')"), "lower('AdA LoVeLaCe')"),
    );
    expect(evalExpr(e, new Map(), { params: {}, source: '' })).toBe('ada lovelace');
  });

  it('lower() of a non-string (or missing prop) is null, never throws', () => {
    const e = parseExpression(new TokenStream(lex('lower($n)'), 'lower($n)'));
    expect(evalExpr(e, new Map(), { params: { n: 42 }, source: '' })).toBeNull();
  });

  it('missing parameters raise RUNTIME_ERROR with position', () => {
    try {
      run('p.born = $nope');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AqlError);
      expect((e as AqlError).code).toBe('RUNTIME_ERROR');
    }
  });
});
