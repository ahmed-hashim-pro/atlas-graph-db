import {
  AGGREGATES,
  MAX_VAR_HOPS,
  MAX_VAR_HOPS_DEFAULT,
  SCALAR_FUNCS,
  walkExpr,
  type CallStatement,
  type DdlStatement,
  type EdgePattern,
  type Expr,
  type NodePattern,
  type ParsedQuery,
  type PathPattern,
  type Pos,
  type ReadQuery,
  type RemoveItem,
  type ReturnItem,
  type SetItem,
  type Statement,
  type WriteClause,
  type WriteQuery,
} from './ast.js';
import { AqlError } from './errors.js';
import { lex } from './lexer.js';
import type { Token } from './lexer.js';

/** Cap on expression nesting depth; protects the recursive parser/walkers from stack overflow. */
const MAX_EXPR_DEPTH = 256;

export class TokenStream {
  private i = 0;
  private depth = 0;

  constructor(
    private readonly tokens: Token[],
    readonly source: string,
  ) {}

  /**
   * Deepen the expression tree by one level, throwing PARSE_ERROR past the cap.
   * Returns the depth at entry so callers can restore() it on exit. This bounds the
   * produced tree depth (not just call recursion), so flat-but-long AND/OR chains —
   * which would otherwise overflow walkExpr/evalExpr/renderExpr — are also capped.
   */
  enter(): number {
    const saved = this.depth;
    if (++this.depth > MAX_EXPR_DEPTH) {
      const t = this.peek();
      throw new AqlError(
        'PARSE_ERROR',
        `expression nesting too deep (max ${MAX_EXPR_DEPTH})`,
        t,
        this.source,
      );
    }
    return saved;
  }

  /** Restore expression-nesting depth to a value previously returned by enter(). */
  restore(saved: number): void {
    this.depth = saved;
  }

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
  const saved = ts.enter();
  try {
    let left = parseAnd(ts);
    while (ts.atKeyword('OR')) {
      // Each new node deepens the left spine of the produced tree by one level.
      ts.enter();
      const p = pos(ts.next());
      left = { kind: 'or', left, right: parseAnd(ts), pos: p };
    }
    return left;
  } finally {
    ts.restore(saved);
  }
}

function parseAnd(ts: TokenStream): Expr {
  const saved = ts.enter();
  try {
    let left = parseNot(ts);
    while (ts.atKeyword('AND')) {
      // Each new node deepens the left spine of the produced tree by one level.
      ts.enter();
      const p = pos(ts.next());
      left = { kind: 'and', left, right: parseNot(ts), pos: p };
    }
    return left;
  } finally {
    ts.restore(saved);
  }
}

function parseNot(ts: TokenStream): Expr {
  const saved = ts.enter();
  try {
    if (ts.atKeyword('NOT')) {
      const p = pos(ts.next());
      return { kind: 'not', expr: parseNot(ts), pos: p };
    }
    return parseComparison(ts);
  } finally {
    ts.restore(saved);
  }
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
    const saved = ts.enter();
    try {
      const items: Expr[] = [];
      if (!ts.atPunct(']')) {
        do {
          items.push(parseExpression(ts));
        } while (ts.takePunct(','));
      }
      ts.expectPunct(']');
      return { kind: 'list', items, pos: pos(t) };
    } finally {
      ts.restore(saved);
    }
  }
  if (t.type === 'punct' && t.value === '(') {
    ts.next();
    const saved = ts.enter();
    try {
      const inner = parseExpression(ts);
      ts.expectPunct(')');
      return inner;
    } finally {
      ts.restore(saved);
    }
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
  const statement = parseStatement(ts);
  if (ts.peek().type !== 'eof') ts.fail('expected end of query');
  validateStatement(statement, source);
  return { explain, statement };
}

function parseStatement(ts: TokenStream): Statement {
  if (ts.atKeyword('CALL')) return { type: 'call', statement: parseCall(ts) };
  if (ts.atKeyword('SHOW') || ts.atKeyword('CREATE') || ts.atKeyword('DROP')) {
    const ddl = tryParseDdl(ts);
    if (ddl) return { type: 'ddl', statement: ddl };
    // CREATE that is not DDL falls through to the write parser below.
  }
  // A statement is a write iff it contains any write clause; otherwise a read.
  // MATCH may precede either, so scan structurally.
  const startsWrite = ts.atKeyword('CREATE') || ts.atKeyword('MERGE');
  if (startsWrite) return { type: 'write', query: parseWriteQuery(ts, undefined) };
  if (ts.atKeyword('MATCH')) {
    const readPrefix = parseMatchPrefix(ts);
    if (isWriteClauseStart(ts)) return { type: 'write', query: parseWriteQuery(ts, readPrefix) };
    return { type: 'read', query: finishReadQuery(ts, readPrefix) };
  }
  ts.fail('expected MATCH, CREATE, MERGE, CALL, SHOW, or DROP');
}

interface MatchPrefix {
  patterns: PathPattern[];
  where?: Expr;
}

function parseMatchPrefix(ts: TokenStream): MatchPrefix {
  ts.expectKeyword('MATCH');
  const patterns: PathPattern[] = [parsePathPattern(ts)];
  while (ts.takePunct(',')) patterns.push(parsePathPattern(ts));
  const where = ts.takeKeyword('WHERE') ? parseExpression(ts) : undefined;
  return { patterns, where };
}

function isWriteClauseStart(ts: TokenStream): boolean {
  return (
    ts.atKeyword('CREATE') ||
    ts.atKeyword('MERGE') ||
    ts.atKeyword('SET') ||
    ts.atKeyword('REMOVE') ||
    ts.atKeyword('DELETE') ||
    ts.atKeyword('DETACH')
  );
}

// Extracted from the old parseReadQuery: everything from RETURN onward.
function finishReadQuery(ts: TokenStream, prefix: MatchPrefix): ReadQuery {
  ts.expectKeyword('RETURN');
  const distinct = ts.takeKeyword('DISTINCT');
  const items = parseReturnItems(ts);
  const { orderBy, skip, limit } = parseReadTail(ts);
  return { patterns: prefix.patterns, where: prefix.where, distinct, items, orderBy, skip, limit };
}

function parseReturnItems(ts: TokenStream): ReturnItem[] {
  const items: ReturnItem[] = [];
  do {
    const start = ts.peek();
    const expr = parseExpression(ts);
    const alias = ts.takeKeyword('AS') ? ts.expectIdent('alias').value : undefined;
    items.push({ expr, alias, pos: { line: start.line, column: start.column } });
  } while (ts.takePunct(','));
  return items;
}

function parseReadTail(ts: TokenStream): {
  orderBy: { expr: Expr; desc: boolean }[];
  skip?: Expr;
  limit?: Expr;
} {
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
  return { orderBy, skip, limit };
}

function parseWriteQuery(ts: TokenStream, prefix: MatchPrefix | undefined): WriteQuery {
  const clauses: WriteClause[] = [];
  for (;;) {
    const t = ts.peek();
    if (ts.takeKeyword('CREATE')) {
      const patterns: PathPattern[] = [parsePathPattern(ts)];
      while (ts.takePunct(',')) patterns.push(parsePathPattern(ts));
      clauses.push({ clause: 'create', patterns, pos: pos(t) });
    } else if (ts.takeKeyword('MERGE')) {
      const pattern = parsePathPattern(ts);
      const onCreate: SetItem[] = [];
      const onMatch: SetItem[] = [];
      while (ts.atKeyword('ON')) {
        ts.next();
        if (ts.takeKeyword('CREATE')) {
          ts.expectKeyword('SET');
          onCreate.push(...parseSetItems(ts));
        } else {
          ts.expectKeyword('MATCH');
          ts.expectKeyword('SET');
          onMatch.push(...parseSetItems(ts));
        }
      }
      clauses.push({ clause: 'merge', pattern, onCreate, onMatch, pos: pos(t) });
    } else if (ts.takeKeyword('SET')) {
      clauses.push({ clause: 'set', items: parseSetItems(ts), pos: pos(t) });
    } else if (ts.takeKeyword('REMOVE')) {
      const items: RemoveItem[] = [];
      do {
        const tgt = ts.expectIdent('variable');
        ts.expectPunct('.');
        const prop = ts.expectIdent('property');
        items.push({ target: tgt.value, property: prop.value, pos: pos(tgt) });
      } while (ts.takePunct(','));
      clauses.push({ clause: 'remove', items, pos: pos(t) });
    } else if (ts.atKeyword('DELETE') || ts.atKeyword('DETACH')) {
      const detach = ts.takeKeyword('DETACH');
      ts.expectKeyword('DELETE');
      const targets: Expr[] = [];
      do {
        targets.push(parseExpression(ts));
      } while (ts.takePunct(','));
      clauses.push({ clause: 'delete', detach, targets, pos: pos(t) });
    } else {
      break;
    }
  }
  if (clauses.length === 0) ts.fail('expected a write clause (CREATE, MERGE, SET, REMOVE, DELETE)');
  let returnItems: ReturnItem[] | undefined;
  let returnDistinct = false;
  let tail: { orderBy: { expr: Expr; desc: boolean }[]; skip?: Expr; limit?: Expr } = {
    orderBy: [],
  };
  if (ts.takeKeyword('RETURN')) {
    returnDistinct = ts.takeKeyword('DISTINCT');
    returnItems = parseReturnItems(ts);
    tail = parseReadTail(ts);
  }
  return {
    readMatch: prefix ? { patterns: prefix.patterns, where: prefix.where } : undefined,
    clauses,
    returnItems,
    returnDistinct,
    orderBy: tail.orderBy,
    skip: tail.skip,
    limit: tail.limit,
  };
}

function parseSetItems(ts: TokenStream): SetItem[] {
  const items: SetItem[] = [];
  do {
    const tgt = ts.expectIdent('variable');
    ts.expectPunct('.');
    const prop = ts.expectIdent('property');
    ts.expectPunct('=');
    items.push({
      target: tgt.value,
      property: prop.value,
      value: parseExpression(ts),
      pos: pos(tgt),
    });
  } while (ts.takePunct(','));
  return items;
}

function tryParseDdl(ts: TokenStream): DdlStatement | null {
  const t = ts.peek();
  if (t.type === 'keyword' && t.value === 'SHOW') {
    ts.next();
    if (ts.takeKeyword('INDEXES')) return { stmt: 'showIndexes', pos: pos(t) };
    if (ts.takeKeyword('CONSTRAINTS')) return { stmt: 'showConstraints', pos: pos(t) };
    ts.fail('expected INDEXES or CONSTRAINTS after SHOW');
  }
  const isCreate = t.type === 'keyword' && t.value === 'CREATE';
  const isDrop = t.type === 'keyword' && t.value === 'DROP';
  if (!isCreate && !isDrop) return null;
  // Look past CREATE/DROP: DDL iff the next token is INDEX, FULLTEXT, or UNIQUE.
  const n = ts.peek(1);
  const ddlNext =
    n.type === 'keyword' && (n.value === 'INDEX' || n.value === 'FULLTEXT' || n.value === 'UNIQUE');
  if (!ddlNext) return null; // CREATE (node...) write — let the write parser handle it
  ts.next(); // consume CREATE/DROP
  let kind: 'property' | 'fulltext' | 'unique' = 'property';
  if (ts.takeKeyword('FULLTEXT')) {
    ts.expectKeyword('INDEX');
    kind = 'fulltext';
  } else if (ts.takeKeyword('UNIQUE')) {
    ts.expectKeyword('CONSTRAINT');
    kind = 'unique';
  } else {
    ts.expectKeyword('INDEX');
    kind = 'property';
  }
  ts.expectKeyword('ON');
  ts.expectPunct(':');
  const label = ts.expectIdent('label').value;
  ts.expectPunct('(');
  const property = ts.expectIdent('property').value;
  ts.expectPunct(')');
  return { stmt: isCreate ? 'createIndex' : 'dropIndex', kind, label, property, pos: pos(t) };
}

function parseCall(ts: TokenStream): CallStatement {
  ts.fail('CALL is not yet implemented'); // implemented in Task 6
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
    const seen = new Set<string>();
    do {
      const prop = ts.expectIdent('property name');
      if (seen.has(prop.value))
        throw new AqlError(
          'SEMANTIC_ERROR',
          `duplicate property "${prop.value}" in pattern`,
          prop,
          ts.source,
        );
      seen.add(prop.value);
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

function validateStatement(stmt: Statement, source: string): void {
  if (stmt.type === 'read') {
    validateQuery(stmt.query, source);
    return;
  }
  if (stmt.type === 'write') {
    validateWriteQuery(stmt.query, source);
    return;
  }
  // ddl/call validated structurally during parsing (Tasks 4, 6)
}

/**
 * Shared reference checker for read and write validators. `allowAlias` lets RETURN/ORDER
 * BY items refer to projection aliases; `allowAggregate` (default false) gates aggregate
 * calls so WHERE/SET/MERGE reject them while RETURN/ORDER BY permit them.
 */
function checkExprRefs(
  e: Expr,
  known: Set<string>,
  source: string,
  allowAlias: boolean,
  aliases?: Set<string>,
  allowAggregate = false,
): void {
  const fail = (msg: string, p: Pos): never => {
    throw new AqlError('SEMANTIC_ERROR', msg, p, source);
  };
  walkExpr(e, (x) => {
    if (x.kind === 'variable' && !known.has(x.name) && !(allowAlias && !!aliases?.has(x.name)))
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
  // Inline pattern props may reference params/literals only (no variables).
  for (const pat of q.patterns)
    for (const n of pat.nodes)
      for (const p of n.props)
        walkExpr(p.value, (x) => {
          if (x.kind === 'variable' || x.kind === 'prop' || x.kind === 'call')
            fail('inline property values must be literals or parameters', x.pos);
        });
  if (q.where) checkExprRefs(q.where, known, source, false, aliases, false);
  for (const item of q.items) checkExprRefs(item.expr, known, source, false, aliases, true);
  for (const o of q.orderBy) checkExprRefs(o.expr, known, source, true, aliases, true);
}

function validateWriteQuery(q: WriteQuery, source: string): void {
  const fail = (msg: string, p: Pos): never => {
    throw new AqlError('SEMANTIC_ERROR', msg, p, source);
  };
  // Variables bound by the leading MATCH, then progressively by CREATE/MERGE.
  const bound = new Set<string>();
  if (q.readMatch) {
    for (const pat of q.readMatch.patterns) {
      for (const n of pat.nodes) if (n.variable) bound.add(n.variable);
      for (const e of pat.edges) if (e.variable) bound.add(e.variable);
    }
    if (q.readMatch.where) checkExprRefs(q.readMatch.where, bound, source, false);
  }
  const noAggregate = (e: Expr): void =>
    walkExpr(e, (x) => {
      if (x.kind === 'call' && AGGREGATES.has(x.func))
        fail('aggregate functions are not allowed in write expressions', x.pos);
    });
  for (const c of q.clauses) {
    if (c.clause === 'create') {
      for (const pat of c.patterns) introduceCreatePattern(pat, bound, fail, source);
    } else if (c.clause === 'merge') {
      // MERGE introduces its pattern's NEW variables; existing ones must already be bound.
      introduceCreatePattern(c.pattern, bound, fail, source, true);
      for (const s of [...c.onCreate, ...c.onMatch]) {
        if (!bound.has(s.target)) fail(`unknown variable "${s.target}"`, s.pos);
        noAggregate(s.value);
        checkExprRefs(s.value, bound, source, false);
      }
    } else if (c.clause === 'set') {
      for (const s of c.items) {
        if (!bound.has(s.target)) fail(`unknown variable "${s.target}"`, s.pos);
        noAggregate(s.value);
        checkExprRefs(s.value, bound, source, false);
      }
    } else if (c.clause === 'remove') {
      for (const r of c.items)
        if (!bound.has(r.target)) fail(`unknown variable "${r.target}"`, r.pos);
    } else {
      for (const t of c.targets) {
        if (t.kind !== 'variable') {
          fail('DELETE targets must be plain variables', t.pos);
          continue;
        }
        if (!bound.has(t.name)) fail(`unknown variable "${t.name}"`, t.pos);
      }
    }
  }
  if (q.returnItems) {
    const aliases = new Set(q.returnItems.map((i) => i.alias).filter((a): a is string => !!a));
    for (const item of q.returnItems) checkExprRefs(item.expr, bound, source, true, aliases);
    for (const o of q.orderBy) checkExprRefs(o.expr, bound, source, true, aliases);
  }
}

/** Bind pattern variables; reject re-declaring a bound var with labels/props. */
function introduceCreatePattern(
  pat: PathPattern,
  bound: Set<string>,
  fail: (msg: string, p: Pos) => never,
  source: string,
  isMerge = false,
): void {
  for (const n of pat.nodes) {
    if (n.variable && bound.has(n.variable)) {
      if (n.labels.length > 0 || n.props.length > 0)
        fail(
          `variable "${n.variable}" is already bound; cannot redeclare with labels/properties`,
          n.pos,
        );
    } else if (n.variable) {
      bound.add(n.variable);
    }
    for (const p of n.props)
      walkExpr(p.value, (x) => {
        if (x.kind === 'variable' || x.kind === 'prop' || x.kind === 'call')
          fail('pattern property values must be literals or parameters', x.pos);
      });
  }
  for (const e of pat.edges) {
    if (e.varLength) fail('variable-length edges are not allowed in CREATE/MERGE', e.pos);
    if (e.variable) {
      if (bound.has(e.variable) && !isMerge)
        fail(`variable "${e.variable}" is already bound`, e.pos);
      bound.add(e.variable);
    }
  }
}
