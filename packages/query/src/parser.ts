import { AGGREGATES, SCALAR_FUNCS, type Expr, type Pos } from './ast.js';
import { AqlError } from './errors.js';
import type { Token } from './lexer.js';

export class TokenStream {
  private i = 0;

  constructor(
    private readonly tokens: Token[],
    readonly source: string,
  ) {}

  peek(offset = 0): Token {
    return this.tokens[Math.min(this.i + offset, this.tokens.length - 1)]!;
  }

  next(): Token {
    const t = this.peek();
    if (t.type !== 'eof') this.i++;
    return t;
  }

  atKeyword(kw: string): boolean {
    const t = this.peek();
    return t.type === 'keyword' && t.value === kw;
  }

  atPunct(p: string): boolean {
    const t = this.peek();
    return t.type === 'punct' && t.value === p;
  }

  takeKeyword(kw: string): boolean {
    if (!this.atKeyword(kw)) return false;
    this.next();
    return true;
  }

  takePunct(p: string): boolean {
    if (!this.atPunct(p)) return false;
    this.next();
    return true;
  }

  expectPunct(p: string): Token {
    if (!this.atPunct(p)) this.fail(`expected "${p}"`);
    return this.next();
  }

  expectKeyword(kw: string): Token {
    if (!this.atKeyword(kw)) this.fail(`expected ${kw}`);
    return this.next();
  }

  expectIdent(what = 'identifier'): Token {
    const t = this.peek();
    if (t.type !== 'ident') this.fail(`expected ${what}`);
    return this.next();
  }

  fail(msg: string, tok: Token = this.peek()): never {
    const at = tok.type === 'eof' ? 'end of query' : `"${tok.value}"`;
    throw new AqlError('PARSE_ERROR', `${msg}, found ${at}`, tok, this.source);
  }
}

function pos(t: Token): Pos {
  return { line: t.line, column: t.column };
}

export function parseExpression(ts: TokenStream): Expr {
  return parseOr(ts);
}

function parseOr(ts: TokenStream): Expr {
  let left = parseAnd(ts);
  while (ts.atKeyword('OR')) {
    const p = pos(ts.next());
    left = { kind: 'or', left, right: parseAnd(ts), pos: p };
  }
  return left;
}

function parseAnd(ts: TokenStream): Expr {
  let left = parseNot(ts);
  while (ts.atKeyword('AND')) {
    const p = pos(ts.next());
    left = { kind: 'and', left, right: parseNot(ts), pos: p };
  }
  return left;
}

function parseNot(ts: TokenStream): Expr {
  if (ts.atKeyword('NOT')) {
    const p = pos(ts.next());
    return { kind: 'not', expr: parseNot(ts), pos: p };
  }
  return parseComparison(ts);
}

const CMP_OPS = ['=', '<>', '<', '<=', '>', '>='] as const;

function parseComparison(ts: TokenStream): Expr {
  const left = parsePrimary(ts);
  const t = ts.peek();
  if (t.type === 'punct' && (CMP_OPS as readonly string[]).includes(t.value)) {
    ts.next();
    return {
      kind: 'cmp',
      op: t.value as (typeof CMP_OPS)[number],
      left,
      right: parsePrimary(ts),
      pos: pos(t),
    };
  }
  if (ts.atKeyword('IN')) {
    const p = pos(ts.next());
    return { kind: 'in', needle: left, haystack: parsePrimary(ts), pos: p };
  }
  if (ts.atKeyword('CONTAINS')) {
    const p = pos(ts.next());
    return { kind: 'text', op: 'contains', left, right: parsePrimary(ts), pos: p };
  }
  if (ts.atKeyword('STARTS')) {
    const p = pos(ts.next());
    ts.expectKeyword('WITH');
    return { kind: 'text', op: 'startsWith', left, right: parsePrimary(ts), pos: p };
  }
  if (ts.atKeyword('ENDS')) {
    const p = pos(ts.next());
    ts.expectKeyword('WITH');
    return { kind: 'text', op: 'endsWith', left, right: parsePrimary(ts), pos: p };
  }
  return left;
}

function parsePrimary(ts: TokenStream): Expr {
  const t = ts.peek();
  if (t.type === 'number') {
    ts.next();
    return { kind: 'literal', value: Number(t.value), pos: pos(t) };
  }
  if (t.type === 'punct' && t.value === '-' && ts.peek(1).type === 'number') {
    ts.next();
    const num = ts.next();
    return { kind: 'literal', value: -Number(num.value), pos: pos(t) };
  }
  if (t.type === 'string') {
    ts.next();
    return { kind: 'literal', value: t.value, pos: pos(t) };
  }
  if (t.type === 'keyword' && (t.value === 'TRUE' || t.value === 'FALSE')) {
    ts.next();
    return { kind: 'literal', value: t.value === 'TRUE', pos: pos(t) };
  }
  if (t.type === 'keyword' && t.value === 'NULL') {
    ts.next();
    return { kind: 'literal', value: null, pos: pos(t) };
  }
  if (t.type === 'param') {
    ts.next();
    return { kind: 'param', name: t.value, pos: pos(t) };
  }
  if (t.type === 'punct' && t.value === '[') {
    ts.next();
    const items: Expr[] = [];
    if (!ts.atPunct(']')) {
      do {
        items.push(parseExpression(ts));
      } while (ts.takePunct(','));
    }
    ts.expectPunct(']');
    return { kind: 'list', items, pos: pos(t) };
  }
  if (t.type === 'punct' && t.value === '(') {
    ts.next();
    const inner = parseExpression(ts);
    ts.expectPunct(')');
    return inner;
  }
  if (t.type === 'keyword' && t.value === 'EXISTS') {
    ts.next();
    ts.expectPunct('(');
    const target = ts.expectIdent('variable');
    ts.expectPunct('.');
    const prop = ts.expectIdent('property name');
    ts.expectPunct(')');
    return { kind: 'exists', target: target.value, property: prop.value, pos: pos(t) };
  }
  if (t.type === 'ident') {
    ts.next();
    if (ts.atPunct('(')) {
      ts.next();
      const distinct = ts.takeKeyword('DISTINCT');
      let arg: Expr | '*';
      if (ts.atPunct('*')) {
        ts.next();
        arg = '*';
      } else {
        arg = parseExpression(ts);
      }
      ts.expectPunct(')');
      return { kind: 'call', func: t.value.toLowerCase(), arg, distinct, pos: pos(t) };
    }
    if (ts.takePunct('.')) {
      const prop = ts.expectIdent('property name');
      return { kind: 'prop', target: t.value, property: prop.value, pos: pos(t) };
    }
    return { kind: 'variable', name: t.value, pos: pos(t) };
  }
  ts.fail('expected an expression');
}

export { AGGREGATES, SCALAR_FUNCS };
