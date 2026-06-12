import { describe, expect, it } from 'vitest';
import { AqlError } from '../src/errors.js';
import { lex } from '../src/lexer.js';
import { TokenStream, parseExpression } from '../src/parser.js';
import type { Expr } from '../src/ast.js';

function parse(src: string): Expr {
  return parseExpression(new TokenStream(lex(src), src));
}

describe('parseExpression', () => {
  it('parses literals, params, props, and variables', () => {
    expect(parse('42')).toMatchObject({ kind: 'literal', value: 42 });
    expect(parse('-3.5')).toMatchObject({ kind: 'literal', value: -3.5 });
    expect(parse("'x'")).toMatchObject({ kind: 'literal', value: 'x' });
    expect(parse('TRUE')).toMatchObject({ kind: 'literal', value: true });
    expect(parse('NULL')).toMatchObject({ kind: 'literal', value: null });
    expect(parse('$min')).toMatchObject({ kind: 'param', name: 'min' });
    expect(parse('p.name')).toMatchObject({ kind: 'prop', target: 'p', property: 'name' });
    expect(parse('p')).toMatchObject({ kind: 'variable', name: 'p' });
  });

  it('honors precedence: OR < AND < NOT < comparison', () => {
    const e = parse('a.x = 1 OR a.y = 2 AND NOT a.z = 3');
    expect(e.kind).toBe('or');
    const or = e as Extract<Expr, { kind: 'or' }>;
    expect(or.left).toMatchObject({ kind: 'cmp', op: '=' });
    expect(or.right.kind).toBe('and');
    const and = or.right as Extract<Expr, { kind: 'and' }>;
    expect(and.right.kind).toBe('not');
  });

  it('parses IN, CONTAINS, STARTS WITH, ENDS WITH, EXISTS, lists, parens', () => {
    expect(parse("p.field IN ['math', 'logic']")).toMatchObject({ kind: 'in' });
    expect(parse("p.name CONTAINS 'love'")).toMatchObject({ kind: 'text', op: 'contains' });
    expect(parse("p.name STARTS WITH 'A'")).toMatchObject({ kind: 'text', op: 'startsWith' });
    expect(parse("p.name ENDS WITH 'e'")).toMatchObject({ kind: 'text', op: 'endsWith' });
    expect(parse('EXISTS(p.born)')).toMatchObject({
      kind: 'exists',
      target: 'p',
      property: 'born',
    });
    expect(parse('(a.x = 1)')).toMatchObject({ kind: 'cmp' });
  });

  it('parses function calls: count(*), collect(DISTINCT x), id(a)', () => {
    expect(parse('count(*)')).toMatchObject({ kind: 'call', func: 'count', arg: '*' });
    expect(parse('collect(DISTINCT p.name)')).toMatchObject({
      kind: 'call',
      func: 'collect',
      distinct: true,
    });
    expect(parse('id(a)')).toMatchObject({ kind: 'call', func: 'id' });
  });

  it('reports positions on malformed expressions', () => {
    try {
      parse('p. ');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AqlError);
      expect((e as AqlError).code).toBe('PARSE_ERROR');
      expect((e as AqlError).snippet).toContain('^');
    }
  });
});
