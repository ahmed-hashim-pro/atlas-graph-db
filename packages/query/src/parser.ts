import {
  AGGREGATES,
  MAX_VAR_HOPS,
  MAX_VAR_HOPS_DEFAULT,
  SCALAR_FUNCS,
  walkExpr,
  type EdgePattern,
  type Expr,
  type NodePattern,
  type ParsedQuery,
  type PathPattern,
  type Pos,
  type ReadQuery,
  type ReturnItem,
} from './ast.js';
import { AqlError } from './errors.js';
import { lex } from './lexer.js';
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

export function parseQuery(source: string): ParsedQuery {
  const ts = new TokenStream(lex(source), source);
  const explain = ts.takeKeyword('EXPLAIN');
  const query = parseReadQuery(ts);
  const trailing = ts.peek();
  if (trailing.type !== 'eof') ts.fail('expected end of query');
  validateQuery(query, source);
  return { explain, query };
}

function parseReadQuery(ts: TokenStream): ReadQuery {
  ts.expectKeyword('MATCH');
  const patterns: PathPattern[] = [parsePathPattern(ts)];
  while (ts.takePunct(',')) patterns.push(parsePathPattern(ts));
  const where = ts.takeKeyword('WHERE') ? parseExpression(ts) : undefined;
  ts.expectKeyword('RETURN');
  const distinct = ts.takeKeyword('DISTINCT');
  const items: ReturnItem[] = [];
  do {
    const start = ts.peek();
    const expr = parseExpression(ts);
    const alias = ts.takeKeyword('AS') ? ts.expectIdent('alias').value : undefined;
    items.push({ expr, alias, pos: pos(start) });
  } while (ts.takePunct(','));
  const orderBy: { expr: Expr; desc: boolean }[] = [];
  if (ts.takeKeyword('ORDER')) {
    ts.expectKeyword('BY');
    do {
      const expr = parseExpression(ts);
      const desc = ts.takeKeyword('DESC') ? true : (ts.takeKeyword('ASC'), false);
      orderBy.push({ expr, desc });
    } while (ts.takePunct(','));
  }
  const skip = ts.takeKeyword('SKIP') ? parseCountExpr(ts) : undefined;
  const limit = ts.takeKeyword('LIMIT') ? parseCountExpr(ts) : undefined;
  return { patterns, where, distinct, items, orderBy, skip, limit };
}

/** SKIP/LIMIT accept only a non-negative integer literal or a parameter. */
function parseCountExpr(ts: TokenStream): Expr {
  const t = ts.peek();
  if (t.type === 'number' || t.type === 'param') return parsePrimary(ts);
  ts.fail('SKIP/LIMIT expect a number or parameter');
}

function parsePathPattern(ts: TokenStream): PathPattern {
  const nodes: NodePattern[] = [parseNodePattern(ts)];
  const edges: EdgePattern[] = [];
  for (;;) {
    if (ts.atPunct('-') || ts.atPunct('<-')) {
      edges.push(parseEdgePattern(ts));
      nodes.push(parseNodePattern(ts));
    } else {
      break;
    }
  }
  return { nodes, edges };
}

function parseNodePattern(ts: TokenStream): NodePattern {
  const open = ts.expectPunct('(');
  const node: NodePattern = { labels: [], props: [], pos: pos(open) };
  if (ts.peek().type === 'ident' && !ts.atPunct(':')) node.variable = ts.next().value;
  while (ts.takePunct(':')) node.labels.push(ts.expectIdent('label').value);
  if (ts.takePunct('{')) {
    do {
      const prop = ts.expectIdent('property name');
      ts.expectPunct(':');
      node.props.push({ property: prop.value, value: parseExpression(ts) });
    } while (ts.takePunct(','));
    ts.expectPunct('}');
  }
  ts.expectPunct(')');
  return node;
}

function parseEdgePattern(ts: TokenStream): EdgePattern {
  const start = ts.peek();
  let direction: 'out' | 'in' | 'both';
  const incoming = ts.takePunct('<-');
  if (!incoming) ts.expectPunct('-');
  ts.expectPunct('[');
  const edge: EdgePattern = { types: [], direction: 'both', pos: pos(start) };
  if (ts.peek().type === 'ident' && !ts.atPunct(':')) edge.variable = ts.next().value;
  if (ts.takePunct(':')) {
    edge.types.push(ts.expectIdent('edge type').value);
    while (ts.takePunct('|')) edge.types.push(ts.expectIdent('edge type').value);
  }
  if (ts.takePunct('*')) {
    const t = ts.peek();
    if (t.type === 'number') {
      ts.next();
      const min = Number(t.value);
      if (ts.takePunct('..')) {
        const maxTok = ts.peek();
        if (maxTok.type !== 'number') ts.fail('expected upper hop bound');
        ts.next();
        edge.varLength = { min, max: Number(maxTok.value) };
      } else {
        edge.varLength = { min, max: min };
      }
    } else {
      edge.varLength = { min: 1, max: MAX_VAR_HOPS_DEFAULT };
    }
  }
  ts.expectPunct(']');
  if (incoming) {
    ts.expectPunct('-');
    direction = 'in';
  } else if (ts.takePunct('->')) {
    direction = 'out';
  } else {
    ts.expectPunct('-');
    direction = 'both';
  }
  edge.direction = direction;
  return edge;
}

function validateQuery(q: ReadQuery, source: string): void {
  const fail = (msg: string, p: Pos): never => {
    throw new AqlError('SEMANTIC_ERROR', msg, p, source);
  };
  const nodeVars = new Set<string>();
  const edgeVars = new Set<string>();
  for (const pat of q.patterns) {
    for (const n of pat.nodes) {
      if (n.variable !== undefined) {
        if (edgeVars.has(n.variable))
          fail(`variable "${n.variable}" is already bound to an edge`, n.pos);
        nodeVars.add(n.variable);
      }
    }
    for (const e of pat.edges) {
      if (e.varLength) {
        if (e.variable !== undefined)
          fail('variable-length edges cannot be bound to a variable in v1', e.pos);
        if (e.varLength.min < 1 || e.varLength.min > e.varLength.max)
          fail(`invalid hop range *${e.varLength.min}..${e.varLength.max}`, e.pos);
        if (e.varLength.max > MAX_VAR_HOPS)
          fail(`hop bound ${e.varLength.max} exceeds the maximum of ${MAX_VAR_HOPS}`, e.pos);
      }
      if (e.variable !== undefined) {
        if (nodeVars.has(e.variable) || edgeVars.has(e.variable))
          fail(`variable "${e.variable}" is already bound`, e.pos);
        edgeVars.add(e.variable);
      }
    }
  }
  const known = new Set([...nodeVars, ...edgeVars]);
  const aliases = new Set(q.items.map((i) => i.alias).filter((a): a is string => a !== undefined));
  const checkRefs = (e: Expr, allowAlias: boolean, allowAggregate: boolean): void => {
    walkExpr(e, (x) => {
      if (x.kind === 'variable' && !known.has(x.name) && !(allowAlias && aliases.has(x.name)))
        fail(`unknown variable "${x.name}"`, x.pos);
      if ((x.kind === 'prop' || x.kind === 'exists') && !known.has(x.target))
        fail(`unknown variable "${x.target}"`, x.pos);
      if (x.kind === 'call') {
        if (!AGGREGATES.has(x.func) && !SCALAR_FUNCS.has(x.func))
          fail(`unknown function "${x.func}"`, x.pos);
        if (AGGREGATES.has(x.func) && !allowAggregate)
          fail(`aggregate function "${x.func}" is not allowed here`, x.pos);
        if (x.arg !== '*' && x.kind === 'call') {
          // no nested aggregates
          walkExpr(x.arg, (inner) => {
            if (inner.kind === 'call' && AGGREGATES.has(inner.func))
              fail('aggregate functions cannot be nested', inner.pos);
          });
        }
      }
    });
  };
  // Inline pattern props may reference params/literals only (no variables).
  for (const pat of q.patterns)
    for (const n of pat.nodes)
      for (const p of n.props)
        walkExpr(p.value, (x) => {
          if (x.kind === 'variable' || x.kind === 'prop' || x.kind === 'call')
            fail('inline property values must be literals or parameters', x.pos);
        });
  if (q.where) checkRefs(q.where, false, false);
  for (const item of q.items) checkRefs(item.expr, false, true);
  for (const o of q.orderBy) checkRefs(o.expr, true, true);
}
