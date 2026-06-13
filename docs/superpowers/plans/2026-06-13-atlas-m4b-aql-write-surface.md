# Atlas M4b — AQL Write Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete AQL — add the write surface to `@atlas/query`: `CREATE`/`MERGE` (Cypher whole-pattern semantics with `ON CREATE SET`/`ON MATCH SET`)/`SET`/`REMOVE`/`DELETE`/`DETACH DELETE`, schema DDL (`CREATE INDEX`/`FULLTEXT INDEX`/`UNIQUE CONSTRAINT`, `DROP`, `SHOW`), and `CALL algo.<name>(...) YIELD ...` — all executing atomically inside `db.transact`, with `EXPLAIN` support and an AQL reference doc.

**Architecture:** The parser grows from "MATCH-only" to a statement dispatcher: a query is a read query (M4a), a standalone DDL/CALL statement, or a `[MATCH ...] (CREATE|MERGE|SET|REMOVE|DELETE)+ [RETURN ...]` write query. Writes compile to a `WritePlan` and run inside a single `db.transact` callback (atomic, WAL-durable) by driving the existing `TxBuilder`; the read-side binding engine from M4a (`runRead`'s generators) is reused to produce the rows that writes operate on. `executeQuery` becomes the one entry point routing read/write/DDL/CALL.

**Tech Stack:** Existing stack. No new packages or dependencies — M4b only extends `@atlas/query` (`ast.ts`, `parser.ts`, `plan.ts`, `exec.ts`, `api.ts`) plus new `write.ts`/`ddl.ts`/`call.ts` modules.

**Spec:** `docs/superpowers/specs/2026-06-10-atlas-graph-platform-design.md` §5.2 — the MERGE normative subsection (whole-pattern match-or-create, ON CREATE/ON MATCH SET in scope, once per binding row, unique-constraint interaction), the Schema DDL list (owner-only enforcement is M5/server scope — here DDL just executes), and the `CALL algo.*` signature table (parameter names + YIELD columns are normative).

**Existing code anchors (read before extending):**
- `packages/query/src/ast.ts`: `Expr` union, `NodePattern { variable?, labels, props: {property,value}[], pos }`, `EdgePattern { variable?, types, direction, varLength?, pos }`, `PathPattern { nodes, edges }`, `ReadQuery`, `ParsedQuery { explain, query }`, `walkExpr`.
- `packages/query/src/parser.ts`: `parseQuery(source): ParsedQuery`, `parseExpression(ts)`, `TokenStream` (methods `peek/next/atKeyword/atPunct/takeKeyword/takePunct/expectPunct/expectKeyword/expectIdent/fail`), private `parseReadQuery`/`parsePathPattern`/`parseNodePattern`/`parseEdgePattern`/`validateQuery`.
- `packages/query/src/exec.ts`: `runRead(plan, query, store, opts): ReadResult`; internal `bindings()` generators, `Binding = Map<string, NodeRecord|EdgeRecord>`, `Guard`, `evalExpr`.
- `packages/query/src/api.ts`: `executeQuery(db, text, opts): Promise<QueryResult>` (async), `explainQuery(db, text)`.
- `packages/core` `TxBuilder`: `createNode(labels, props?) → NodeId`, `createEdge(type, from, to, props?) → EdgeId`, `setNodeProps(id, set, remove?)`, `setEdgeProps(id, set, remove?)`, `deleteEdge(id)`, `deleteNode(id, {detach?})`, `createIndex(def)`, `dropIndex(def)`; `db.transact(fn)` async-atomic; `db.algo.*`; `db.listIndexes()`; `IndexDef { kind:'property'|'fulltext'|'unique', label, property }`.

---

## File structure

```
packages/query/src/
  ast.ts        MODIFY: lexer keyword additions consumed here; add WriteClause/WriteQuery/
                DdlStatement/CallStatement/Statement union; ParsedQuery.statement
  lexer.ts      MODIFY: register new keywords (CREATE, MERGE, SET, REMOVE, DELETE, DETACH,
                ON, INDEX, FULLTEXT, CONSTRAINT, UNIQUE, DROP, SHOW, INDEXES, CONSTRAINTS,
                CALL, YIELD, FOR)
  parser.ts     MODIFY: parseQuery dispatches; add parseWriteQuery/parseDdl/parseCall +
                write-aware validation (a small but real grammar growth — keep cohesive)
  plan.ts       MODIFY: add WritePlanNode variants (CreatePattern/Merge/SetProps/RemoveProps/
                DeleteNode/DeleteEdge), DdlPlan, CallPlan; serialize them for EXPLAIN
  write.ts      NEW: runWrite(plan, store, tx, params, source, guard) — drives TxBuilder from
                bindings; MERGE match-or-create; ON CREATE/ON MATCH SET
  ddl.ts        NEW: runDdl(stmt, db/tx) — index/constraint create/drop; SHOW reads listIndexes
  call.ts       NEW: runCall(stmt, db, params) — maps CALL algo.* to db.algo, YIELD projection
  api.ts        MODIFY: executeQuery routes read/write/ddl/call; EXPLAIN for all; write/call paths
                use db.transact / await db.algo
  index.ts      MODIFY: export new public types
docs/aql-reference.md   NEW (Task 11): the language reference
README.md               MODIFY (Task 11): status
```

Conventions: ESM `.js` import extensions; commits end with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; never run bare `vitest` (always `pnpm vitest run`); positions 1-based.

---

### Task 1: Lexer keywords + write-statement AST

**Files:**
- Modify: `packages/query/src/lexer.ts`, `packages/query/src/ast.ts`
- Test: `packages/query/test/lexer-write.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/query/test/lexer-write.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { lex } from '../src/lexer.js';

function kinds(src: string): string[] {
  return lex(src)
    .filter((t) => t.type !== 'eof')
    .map((t) => `${t.type}:${t.value}`);
}

describe('lexer — write keywords', () => {
  it('recognizes all new keywords case-insensitively', () => {
    expect(kinds('create merge set remove delete detach on')).toEqual([
      'keyword:CREATE',
      'keyword:MERGE',
      'keyword:SET',
      'keyword:REMOVE',
      'keyword:DELETE',
      'keyword:DETACH',
      'keyword:ON',
    ]);
    expect(kinds('INDEX FULLTEXT CONSTRAINT UNIQUE DROP SHOW INDEXES CONSTRAINTS')).toEqual([
      'keyword:INDEX',
      'keyword:FULLTEXT',
      'keyword:CONSTRAINT',
      'keyword:UNIQUE',
      'keyword:DROP',
      'keyword:SHOW',
      'keyword:INDEXES',
      'keyword:CONSTRAINTS',
    ]);
    expect(kinds('call yield for')).toEqual(['keyword:CALL', 'keyword:YIELD', 'keyword:FOR']);
  });

  it('keeps identifiers that merely contain keywords intact', () => {
    expect(kinds('created merger')).toEqual(['ident:created', 'ident:merger']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/query/test/lexer-write.test.ts`
Expected: FAIL — new words lex as `ident`, not `keyword`.

- [ ] **Step 3: Implement**

In `packages/query/src/lexer.ts`, extend the `KEYWORDS` set with the new words (append to the existing literal set):

```ts
  'CREATE', 'MERGE', 'SET', 'REMOVE', 'DELETE', 'DETACH', 'ON',
  'INDEX', 'FULLTEXT', 'CONSTRAINT', 'UNIQUE', 'DROP', 'SHOW', 'INDEXES', 'CONSTRAINTS',
  'CALL', 'YIELD', 'FOR',
```

In `packages/query/src/ast.ts`, append the statement AST (after the existing `ParsedQuery` interface, and CHANGE `ParsedQuery` as shown):

```ts
export interface SetItem {
  /** target.property = value, or target += map is out of scope (v1: single prop). */
  target: string;
  property: string;
  value: Expr;
  pos: Pos;
}

export interface RemoveItem {
  target: string;
  property: string;
  pos: Pos;
}

export type WriteClause =
  | { clause: 'create'; patterns: PathPattern[]; pos: Pos }
  | {
      clause: 'merge';
      pattern: PathPattern;
      onCreate: SetItem[];
      onMatch: SetItem[];
      pos: Pos;
    }
  | { clause: 'set'; items: SetItem[]; pos: Pos }
  | { clause: 'remove'; items: RemoveItem[]; pos: Pos }
  | { clause: 'delete'; detach: boolean; targets: Expr[]; pos: Pos };

export interface WriteQuery {
  /** optional leading MATCH providing bindings the write clauses operate on */
  readMatch?: { patterns: PathPattern[]; where?: Expr };
  clauses: WriteClause[];
  /** optional trailing RETURN (projection over post-write bindings) */
  returnItems?: ReturnItem[];
  returnDistinct: boolean;
  orderBy: { expr: Expr; desc: boolean }[];
  skip?: Expr;
  limit?: Expr;
}

export type DdlStatement =
  | { stmt: 'createIndex'; kind: 'property' | 'fulltext' | 'unique'; label: string; property: string; pos: Pos }
  | { stmt: 'dropIndex'; kind: 'property' | 'fulltext' | 'unique'; label: string; property: string; pos: Pos }
  | { stmt: 'showIndexes'; pos: Pos }
  | { stmt: 'showConstraints'; pos: Pos };

export interface CallStatement {
  /** namespaced algorithm name, e.g. "algo.pagerank" */
  name: string;
  args: Expr[];
  yields: { name: string; alias?: string }[];
  pos: Pos;
}

export type Statement =
  | { type: 'read'; query: ReadQuery }
  | { type: 'write'; query: WriteQuery }
  | { type: 'ddl'; statement: DdlStatement }
  | { type: 'call'; statement: CallStatement };

export interface ParsedQuery {
  explain: boolean;
  statement: Statement;
}
```

This **changes** the shape of `ParsedQuery` (was `{ explain, query }`). M4a code reads `parsed.query`/`parsed.explain`; Task 2 updates the parser to return `{ explain, statement }`, and Task 8 updates `api.ts`. Until then build is red — that's expected mid-task and resolved within this plan; do not attempt to keep both shapes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/query/test/lexer-write.test.ts`
Expected: PASS (the lexer test does not depend on the AST change). Do NOT run the full build yet — the `ParsedQuery` change makes it red until Task 2.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(query): lex write keywords; statement-level AST types"
```

### Task 2: Statement dispatch + write-query parser

**Files:**
- Modify: `packages/query/src/parser.ts`
- Test: `packages/query/test/parser-write.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/query/test/parser-write.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AqlError } from '../src/errors.js';
import { parseQuery } from '../src/parser.js';

function write(src: string) {
  const p = parseQuery(src);
  if (p.statement.type !== 'write') throw new Error(`expected write, got ${p.statement.type}`);
  return p.statement.query;
}

describe('parseQuery — read still works through the new dispatcher', () => {
  it('classifies a MATCH...RETURN as a read statement', () => {
    const p = parseQuery('MATCH (n:Person) RETURN n');
    expect(p.statement.type).toBe('read');
  });
});

describe('parseQuery — CREATE', () => {
  it('parses standalone CREATE with multiple patterns', () => {
    const q = write("CREATE (a:Person {name: 'Ada'}), (a)-[:WROTE]->(d:Document {title: 'Notes'})");
    expect(q.clauses).toHaveLength(1);
    const c = q.clauses[0]!;
    expect(c.clause).toBe('create');
    if (c.clause === 'create') expect(c.patterns).toHaveLength(2);
    expect(q.readMatch).toBeUndefined();
  });

  it('parses MATCH ... CREATE ... RETURN', () => {
    const q = write('MATCH (a:Person) CREATE (a)-[:KNOWS]->(b:Person {name: $n}) RETURN b');
    expect(q.readMatch?.patterns).toHaveLength(1);
    expect(q.clauses[0]!.clause).toBe('create');
    expect(q.returnItems).toHaveLength(1);
  });
});

describe('parseQuery — MERGE/SET/REMOVE/DELETE', () => {
  it('parses MERGE with ON CREATE SET / ON MATCH SET', () => {
    const q = write(
      "MERGE (p:Person {email: $e}) ON CREATE SET p.created = $now ON MATCH SET p.seen = $now RETURN p",
    );
    const c = q.clauses[0]!;
    expect(c.clause).toBe('merge');
    if (c.clause === 'merge') {
      expect(c.onCreate).toHaveLength(1);
      expect(c.onMatch).toHaveLength(1);
      expect(c.onCreate[0]).toMatchObject({ target: 'p', property: 'created' });
    }
  });

  it('parses SET multiple items and REMOVE', () => {
    const q = write('MATCH (p:Person) SET p.born = 1815, p.field = $f REMOVE p.tmp RETURN p');
    expect(q.clauses[0]).toMatchObject({ clause: 'set' });
    expect(q.clauses[1]).toMatchObject({ clause: 'remove' });
    if (q.clauses[0]!.clause === 'set') expect(q.clauses[0]!.items).toHaveLength(2);
  });

  it('parses DELETE and DETACH DELETE with multiple targets', () => {
    const a = write('MATCH (p:Person) DELETE p');
    expect(a.clauses[0]).toMatchObject({ clause: 'delete', detach: false });
    const b = write('MATCH (p)-[r]->(q) DETACH DELETE p, q');
    const c = b.clauses[0]!;
    expect(c.clause).toBe('delete');
    if (c.clause === 'delete') {
      expect(c.detach).toBe(true);
      expect(c.targets).toHaveLength(2);
    }
  });

  it('chains multiple write clauses', () => {
    const q = write("CREATE (n:T {v: 1}) SET n.v = 2 RETURN n");
    expect(q.clauses.map((c) => c.clause)).toEqual(['create', 'set']);
  });
});

describe('parseQuery — write validation', () => {
  const err = (src: string): AqlError => {
    try {
      parseQuery(src);
    } catch (e) {
      return e as AqlError;
    }
    throw new Error('expected throw');
  };

  it('SET/REMOVE/DELETE on unknown variables fail', () => {
    expect(err('MATCH (p) SET q.x = 1 RETURN p').code).toBe('SEMANTIC_ERROR');
    expect(err('MATCH (p) DELETE q').code).toBe('SEMANTIC_ERROR');
  });

  it('DELETE target must be a plain variable', () => {
    expect(err('MATCH (p) DELETE p.name').code).toBe('SEMANTIC_ERROR');
  });

  it('CREATE cannot reintroduce a bound variable with labels/props', () => {
    expect(err('MATCH (a:Person) CREATE (a:Person) RETURN a').code).toBe('SEMANTIC_ERROR');
  });

  it('aggregates are not allowed in SET/MERGE values', () => {
    expect(err('MATCH (p) SET p.c = count(p) RETURN p').code).toBe('SEMANTIC_ERROR');
  });

  it('RETURN after write still validates variable references', () => {
    expect(err('CREATE (n:T) RETURN m').code).toBe('SEMANTIC_ERROR');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/query/test/parser-write.test.ts`
Expected: FAIL — `parsed.statement` undefined / write clauses unparsed.

- [ ] **Step 3: Implement**

In `packages/query/src/parser.ts`, rewrite `parseQuery` to dispatch and add the write grammar. Replace the existing `parseQuery` function with:

```ts
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
  const startsWrite =
    ts.atKeyword('CREATE') || ts.atKeyword('MERGE');
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
```

Now add the write-query parser. Note: `finishReadQuery` is a small refactor — the existing `parseReadQuery` body after the MATCH/WHERE part (RETURN/ORDER BY/SKIP/LIMIT) must be extracted into `finishReadQuery(ts, prefix)` so both read and the dispatcher reuse it. Show the refactor explicitly:

```ts
// Extracted from the old parseReadQuery: everything from RETURN onward.
function finishReadQuery(ts: TokenStream, prefix: MatchPrefix): ReadQuery {
  ts.expectKeyword('RETURN');
  const distinct = ts.takeKeyword('DISTINCT');
  const items = parseReturnItems(ts);
  const { orderBy, skip, limit } = parseReadTail(ts);
  return { patterns: prefix.patterns, where: prefix.where, distinct, items, orderBy, skip, limit };
}
```

Extract these shared helpers from the existing RETURN/tail code (replace the inline code in the old `parseReadQuery` with calls to them; `parseReadQuery` itself is no longer called — `parseStatement` handles reads):

```ts
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
  let tail: { orderBy: { expr: Expr; desc: boolean }[]; skip?: Expr; limit?: Expr } = { orderBy: [] };
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
    items.push({ target: tgt.value, property: prop.value, value: parseExpression(ts), pos: pos(tgt) });
  } while (ts.takePunct(','));
  return items;
}
```

Add imports for the new AST types at the top of the file's `./ast.js` import (`Statement`, `WriteQuery`, `WriteClause`, `SetItem`, `RemoveItem`, `DdlStatement`, `CallStatement`). `tryParseDdl`/`parseCall` are stubbed for now — add temporary stubs so the file compiles; Tasks 4 and 6 implement them:

```ts
function tryParseDdl(_ts: TokenStream): DdlStatement | null {
  return null; // implemented in Task 4
}

function parseCall(ts: TokenStream): CallStatement {
  ts.fail('CALL is not yet implemented'); // implemented in Task 6
}
```

Add the write validation. Append to the existing validation logic a `validateStatement` dispatcher that calls the existing read validation for reads and a new `validateWriteQuery`:

```ts
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
      for (const pat of c.patterns)
        introduceCreatePattern(pat, bound, fail, source);
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
      for (const r of c.items) if (!bound.has(r.target)) fail(`unknown variable "${r.target}"`, r.pos);
    } else {
      for (const t of c.targets) {
        if (t.kind !== 'variable') fail('DELETE targets must be plain variables', t.pos);
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
        fail(`variable "${n.variable}" is already bound; cannot redeclare with labels/properties`, n.pos);
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
      if (bound.has(e.variable) && !isMerge) fail(`variable "${e.variable}" is already bound`, e.pos);
      bound.add(e.variable);
    }
  }
}
```

Note: `checkExprRefs` is the existing reference checker used inside `validateQuery` — extract it (if it is currently a closure named `checkRefs` inside `validateQuery`) into a module-level `function checkExprRefs(e, known, source, allowAlias, aliases?)` so both validators share it. Keep `validateQuery`'s behavior identical.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/query/test/parser-write.test.ts packages/query/test/parser.test.ts packages/query/test/expr-parser.test.ts`
Expected: PASS — write parsing works AND the M4a parser/expr suites still pass through the refactor. (Build remains red until Task 8 fixes `api.ts`; that's fine — tests import modules directly.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(query): statement dispatcher and write-query parser with validation"
```

### Task 3: Write executor — CREATE, SET, REMOVE, DELETE

The write executor runs inside a `db.transact` callback driving a `TxBuilder`. It reuses M4a's binding engine: a leading MATCH produces bindings (zero or more rows); write clauses run once per binding row (or exactly once when there is no MATCH). CREATE binds new variables into each row's binding so later clauses and RETURN see them.

**Files:**
- Create: `packages/query/src/write.ts`
- Modify: `packages/query/src/exec.ts` (export a reusable `matchBindings` helper)
- Test: `packages/query/test/write-exec.test.ts`

- [ ] **Step 1: Export the binding helper from exec.ts**

In `packages/query/src/exec.ts`, the binding generators currently live inside `runRead`. Extract the binding-subtree walk into an exported function so writes can reuse it. Add (near the top-level exports):

```ts
import { planQuery } from './planner.js';
import type { ReadQuery } from './ast.js';

/**
 * Produce match bindings for a read pattern (no projection). Used by the write
 * executor to drive per-row writes. Returns concrete Binding rows (eagerly
 * materialized — writers mutate the store as they go, so lazy iteration over a
 * changing graph is unsafe).
 */
export function matchBindings(
  patterns: ReadQuery['patterns'],
  where: ReadQuery['where'],
  store: GraphStore,
  opts: ExecOptions,
): Binding[] {
  const pseudo: ReadQuery = {
    patterns,
    where,
    distinct: false,
    items: [],
    orderBy: [],
  };
  const plan = planQuery(pseudo, store);
  const guard = new Guard(opts);
  const ctx: EvalContext = { params: opts.params, source: opts.source };
  // Reuse the same binding-subtree walker runRead uses; collect eagerly.
  return collectBindings(plan, store, guard, ctx);
}
```

This requires refactoring `runRead` so its internal `bindings(node)` generator and the "descend to binding root" logic become a shared module-level `collectBindings(plan, store, guard, ctx): Binding[]` (returns all rows) plus the result stage. Do the refactor minimally: move the `bindings` generator and `edgesFor`/`extend`/`hasAllLabels`/`isBindingOp` helpers to module scope (parameterized by `store`, `guard`, `ctx`), have `runRead` call `collectBindings` then run its existing result stage over the returned rows. Keep all M4a exec tests green — they are the contract for this refactor.

`Binding`, `ExecOptions`, `Guard`, `EvalContext` are already in this module; export `matchBindings` and the `Binding` type if not already exported.

- [ ] **Step 2: Write the failing tests**

`packages/query/test/write-exec.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '@atlas/core';
import { parseQuery } from '../src/parser.js';
import { runWrite } from '../src/write.js';

let dir: string;
let db: AtlasDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-write-'));
  db = await openDatabase(dir);
});
afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

async function exec(src: string, params: Record<string, unknown> = {}) {
  const parsed = parseQuery(src);
  if (parsed.statement.type !== 'write') throw new Error('not a write');
  const wq = parsed.statement.query;
  return db.transact((tx) => {
    // runWrite returns the post-write bindings; tests assert via the store after commit.
    runWrite(wq, db.graphStore, tx, { params, source: src });
  });
}

describe('CREATE', () => {
  it('creates nodes and edges with properties', async () => {
    await exec("CREATE (a:Person {name: 'Ada', born: 1815}), (a)-[:WROTE]->(d:Document {title: 'Notes'})");
    const people = [...db.nodesByLabel('Person')];
    expect(people).toHaveLength(1);
    expect(people[0]!.props).toMatchObject({ name: 'Ada', born: 1815 });
    expect(db.outEdges(people[0]!.id, 'WROTE')).toHaveLength(1);
  });

  it('MATCH ... CREATE runs once per matched row', async () => {
    await exec("CREATE (:Person {name: 'A'}), (:Person {name: 'B'})");
    await exec("MATCH (p:Person) CREATE (p)-[:HAS]->(:Tag {v: 1})");
    expect([...db.nodesByLabel('Tag')]).toHaveLength(2); // one per person
  });

  it('parameters supply property values', async () => {
    await exec('CREATE (n:T {v: $v})', { v: 42 });
    expect([...db.nodesByLabel('T')][0]!.props.v).toBe(42);
  });
});

describe('SET / REMOVE', () => {
  it('sets and removes node properties on matched rows', async () => {
    await exec("CREATE (:Person {name: 'Ada', tmp: 1})");
    await exec("MATCH (p:Person {name: 'Ada'}) SET p.born = 1815, p.field = $f REMOVE p.tmp", { f: 'math' });
    const ada = [...db.nodesByLabel('Person')][0]!;
    expect(ada.props).toEqual({ name: 'Ada', born: 1815, field: 'math' });
  });

  it('sets edge properties via a bound edge variable', async () => {
    await exec("CREATE (a:P)-[:R]->(b:P)");
    await exec('MATCH (a:P)-[r:R]->(b:P) SET r.weight = 5');
    const a = [...db.nodesByLabel('P')].find((n) => db.outEdges(n.id, 'R').length > 0)!;
    expect(db.outEdges(a.id, 'R')[0]!.props.weight).toBe(5);
  });
});

describe('DELETE', () => {
  it('DELETE removes an edgeless node; refuses one with edges without DETACH', async () => {
    await exec("CREATE (:Lonely {v: 1})");
    await exec('MATCH (n:Lonely) DELETE n');
    expect([...db.nodesByLabel('Lonely')]).toHaveLength(0);

    await exec("CREATE (a:Linked)-[:R]->(b:Linked)");
    await expect(exec('MATCH (a:Linked)-[:R]->(b) DELETE a')).rejects.toThrow();
  });

  it('DETACH DELETE removes a node and its edges', async () => {
    await exec("CREATE (a:Hub)-[:R]->(b:Leaf), (a)-[:R]->(c:Leaf)");
    await exec('MATCH (a:Hub) DETACH DELETE a');
    expect([...db.nodesByLabel('Hub')]).toHaveLength(0);
    expect([...db.nodesByLabel('Leaf')]).toHaveLength(2); // leaves remain, edges gone
  });

  it('rolls back the whole statement on failure (atomic)', async () => {
    await exec("CREATE (a:Linked)-[:R]->(b:Linked)");
    await expect(exec('MATCH (a:Linked)-[:R]->(b) CREATE (:Extra) DELETE a')).rejects.toThrow();
    expect([...db.nodesByLabel('Extra')]).toHaveLength(0); // the CREATE rolled back too
  });
});

describe('RETURN after write', () => {
  it('projects post-write bindings', async () => {
    const result = await runReturn("CREATE (n:T {v: 7}) RETURN n.v AS v");
    expect(result.rows).toEqual([[7]]);
  });

  async function runReturn(src: string) {
    const parsed = parseQuery(src);
    if (parsed.statement.type !== 'write') throw new Error('not a write');
    const wq = parsed.statement.query;
    let captured: { columns: string[]; rows: unknown[][] } = { columns: [], rows: [] };
    await db.transact((tx) => {
      captured = runWrite(wq, db.graphStore, tx, { params: {}, source: src });
    });
    return captured;
  }
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run packages/query/test/write-exec.test.ts`
Expected: FAIL — `write.js` not found.

- [ ] **Step 4: Implement**

`packages/query/src/write.ts`:

```ts
import type { EdgeRecord, GraphStore, NodeId, NodeRecord, Props, TxBuilder } from '@atlas/core';
import type { PathPattern, SetItem, WriteClause, WriteQuery } from './ast.js';
import { AqlError } from './errors.js';
import { evalExpr, type Binding, type EvalContext, type RuntimeValue } from './eval.js';
import { matchBindings, type ExecOptions } from './exec.js';

export interface WriteResult {
  columns: string[];
  rows: RuntimeValue[][];
  stats: { created: number; deleted: number; propsSet: number };
}

interface WriteCtx {
  store: GraphStore;
  tx: TxBuilder;
  eval: EvalContext;
  stats: { created: number; deleted: number; propsSet: number };
}

/** Evaluate inline pattern props (literals/params only — validator enforced) to a Props map. */
function evalProps(
  props: { property: string; value: import('./ast.js').Expr }[],
  ctx: WriteCtx,
  binding: Binding,
): Props {
  const out: Props = {};
  for (const p of props) {
    const v = evalExpr(p.value, binding, ctx.eval);
    if (v === null) continue; // null property = absent
    out[p.property] = v as Props[string];
  }
  return out;
}

/** CREATE a path pattern within one binding row, binding new variables as it goes. */
function createPattern(pat: PathPattern, ctx: WriteCtx, binding: Binding): void {
  const nodeIds: NodeId[] = [];
  for (const n of pat.nodes) {
    if (n.variable && binding.has(n.variable)) {
      nodeIds.push((binding.get(n.variable) as NodeRecord).id);
      continue;
    }
    if (n.labels.length === 0)
      throw new AqlError('RUNTIME_ERROR', 'CREATE node requires at least one label', n.pos, ctx.eval.source);
    const id = ctx.tx.createNode(n.labels, evalProps(n.props, ctx, binding));
    ctx.stats.created++;
    nodeIds.push(id);
    if (n.variable) binding.set(n.variable, { id, labels: n.labels, props: {} } as NodeRecord);
  }
  for (let i = 0; i < pat.edges.length; i++) {
    const e = pat.edges[i]!;
    if (e.types.length !== 1)
      throw new AqlError('RUNTIME_ERROR', 'CREATE edge requires exactly one type', e.pos, ctx.eval.source);
    const dir = e.direction;
    const [from, to] =
      dir === 'in' ? [nodeIds[i + 1]!, nodeIds[i]!] : [nodeIds[i]!, nodeIds[i + 1]!];
    if (dir === 'both')
      throw new AqlError('RUNTIME_ERROR', 'CREATE edges must be directed', e.pos, ctx.eval.source);
    const id = ctx.tx.createEdge(e.types[0]!, from, to, {});
    ctx.stats.created++;
    if (e.variable) binding.set(e.variable, { id, type: e.types[0]!, from, to, props: {} } as EdgeRecord);
  }
}

function applySet(items: SetItem[], ctx: WriteCtx, binding: Binding): void {
  for (const s of items) {
    const rec = binding.get(s.target);
    if (!rec) throw new AqlError('RUNTIME_ERROR', `SET target "${s.target}" is not bound`, s.pos, ctx.eval.source);
    const v = evalExpr(s.value, binding, ctx.eval);
    const isEdge = 'type' in rec;
    if (v === null) {
      if (isEdge) ctx.tx.setEdgeProps(rec.id, {}, [s.property]);
      else ctx.tx.setNodeProps(rec.id, {}, [s.property]);
    } else if (isEdge) {
      ctx.tx.setEdgeProps(rec.id, { [s.property]: v as Props[string] });
    } else {
      ctx.tx.setNodeProps(rec.id, { [s.property]: v as Props[string] });
    }
    ctx.stats.propsSet++;
  }
}

function runClause(clause: WriteClause, ctx: WriteCtx, binding: Binding): void {
  switch (clause.clause) {
    case 'create':
      for (const pat of clause.patterns) createPattern(pat, ctx, binding);
      return;
    case 'set':
      applySet(clause.items, ctx, binding);
      return;
    case 'remove':
      for (const r of clause.items) {
        const rec = binding.get(r.target)!;
        if ('type' in rec) ctx.tx.setEdgeProps(rec.id, {}, [r.property]);
        else ctx.tx.setNodeProps(rec.id, {}, [r.property]);
        ctx.stats.propsSet++;
      }
      return;
    case 'delete':
      for (const target of clause.targets) {
        const rec = binding.get((target as { name: string }).name)!;
        if ('type' in rec) ctx.tx.deleteEdge(rec.id);
        else ctx.tx.deleteNode(rec.id, { detach: clause.detach });
        ctx.stats.deleted++;
      }
      return;
    case 'merge':
      throw new AqlError('RUNTIME_ERROR', 'MERGE handled in Task 4', clause.pos, ctx.eval.source);
  }
}

export function runWrite(
  query: WriteQuery,
  store: GraphStore,
  tx: TxBuilder,
  opts: { params: Record<string, unknown>; source: string },
): WriteResult {
  const execOpts: ExecOptions = {
    params: opts.params,
    source: opts.source,
    timeoutMs: 30_000,
    maxRows: 1_000_000,
  };
  const ctx: WriteCtx = {
    store,
    tx,
    eval: { params: opts.params, source: opts.source },
    stats: { created: 0, deleted: 0, propsSet: 0 },
  };
  // Rows the write operates on: MATCH results, or a single empty binding.
  const rows: Binding[] = query.readMatch
    ? matchBindings(query.readMatch.patterns, query.readMatch.where, store, execOpts)
    : [new Map()];

  for (const baseBinding of rows) {
    const binding = new Map(baseBinding);
    for (const clause of query.clauses) runClause(clause, ctx, binding);
    baseBinding.__final = binding; // stash for RETURN (see below)
  }

  // RETURN projection over post-write bindings.
  if (!query.returnItems) return { columns: [], rows: [], stats: ctx.stats };
  const columns = query.returnItems.map((it, i) => it.alias ?? `col${i}`);
  let outRows: RuntimeValue[][] = rows.map((base) => {
    const b = (base as { __final?: Binding }).__final ?? base;
    return query.returnItems!.map((it) => evalExpr(it.expr, b, ctx.eval));
  });
  if (query.returnDistinct) outRows = dedupRows(outRows);
  return { columns, rows: outRows, stats: ctx.stats };
}

function dedupRows(rows: RuntimeValue[][]): RuntimeValue[][] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = JSON.stringify(r.map((v) => (v && typeof v === 'object' && 'id' in v ? `#${v.id}` : v)));
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
```

Note: the `baseBinding.__final` stash is a hack — replace it with a clean parallel array. Implementer: keep a `const finals: Binding[] = []` and push the per-row final binding, then project from `finals`. Do not add a `__final` field to the `Binding` Map type. (This note exists because the inline code above shows the intent; implement it with the parallel array, and the `RETURN` projection reads `finals[i]`.) Records stashed into bindings for freshly-created elements carry empty/partial `props`; since RETURN after CREATE typically returns whole nodes or `id(n)`, re-read from the store for property access: when projecting a `prop` expr whose target was created in this statement, read the live record via `store.getNode/getEdge` by the bound id. Simplest correct approach: after each row's clauses run, refresh every bound variable from the store (`store.getNode(rec.id)`/`store.getEdge(rec.id)`) into the final binding so RETURN sees committed-in-tx values. Implement that refresh.

Add `TxBuilder` to `@atlas/core`'s exports if not already exported (it is — `export { TxBuilder }` exists in core's index).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run packages/query/test/write-exec.test.ts && pnpm vitest run packages/query/test/exec-basic.test.ts packages/query/test/exec-patterns.test.ts packages/query/test/exec-aggregate.test.ts`
Expected: PASS — writes work AND the M4a exec suites survive the `collectBindings` refactor.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(query): write executor for CREATE/SET/REMOVE/DELETE inside transactions"
```

### Task 4: MERGE semantics

Spec §5.2 MERGE: match the **whole pattern**; if no complete match exists, create the entire pattern. Runs once per incoming binding row. `ON CREATE SET` applies only on the create path, `ON MATCH SET` only when matched. A create that violates a unique constraint surfaces `CONSTRAINT_VIOLATION` (the engine raises it at commit — MERGE does not pre-check).

**Files:**
- Modify: `packages/query/src/write.ts`
- Test: `packages/query/test/merge-exec.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/query/test/merge-exec.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '@atlas/core';
import { parseQuery } from '../src/parser.js';
import { runWrite } from '../src/write.js';

let dir: string;
let db: AtlasDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-merge-'));
  db = await openDatabase(dir);
});
afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

async function exec(src: string, params: Record<string, unknown> = {}) {
  const parsed = parseQuery(src);
  if (parsed.statement.type !== 'write') throw new Error('not a write');
  return db.transact((tx) => {
    runWrite(parsed.statement.type === 'write' ? parsed.statement.query : (null as never), db.graphStore, tx, {
      params,
      source: src,
    });
  });
}

describe('MERGE — single node', () => {
  it('creates when absent, matches when present (no duplicate)', async () => {
    await exec("MERGE (p:Person {email: 'a@x'})");
    await exec("MERGE (p:Person {email: 'a@x'})");
    expect([...db.nodesByLabel('Person')]).toHaveLength(1);
    await exec("MERGE (p:Person {email: 'b@x'})");
    expect([...db.nodesByLabel('Person')]).toHaveLength(2);
  });

  it('ON CREATE SET fires only on creation; ON MATCH SET only on match', async () => {
    await exec("MERGE (p:Person {email: 'a@x'}) ON CREATE SET p.created = 1 ON MATCH SET p.seen = 1");
    let p = [...db.nodesByLabel('Person')][0]!;
    expect(p.props).toEqual({ email: 'a@x', created: 1 });
    await exec("MERGE (p:Person {email: 'a@x'}) ON CREATE SET p.created = 2 ON MATCH SET p.seen = 9");
    p = db.getNode(p.id)!;
    expect(p.props).toEqual({ email: 'a@x', created: 1, seen: 9 }); // created untouched, seen added
  });
});

describe('MERGE — whole pattern semantics', () => {
  it('creates the ENTIRE pattern when the full pattern does not match, even if endpoints exist', async () => {
    await exec("CREATE (:Person {name: 'Ada'}), (:Document {title: 'Notes'})");
    // No WROTE edge exists, so the whole pattern fails to match -> create fresh nodes + edge.
    await exec(
      "MERGE (p:Person {name: 'Ada'})-[:WROTE]->(d:Document {title: 'Notes'})",
    );
    expect([...db.nodesByLabel('Person')]).toHaveLength(2); // a NEW Ada was created
    expect([...db.nodesByLabel('Document')]).toHaveLength(2);
  });

  it('matches an existing full pattern without creating', async () => {
    await exec("CREATE (p:Person {name: 'Ada'})-[:WROTE]->(d:Document {title: 'Notes'})");
    await exec("MERGE (p:Person {name: 'Ada'})-[:WROTE]->(d:Document {title: 'Notes'})");
    expect([...db.nodesByLabel('Person')]).toHaveLength(1);
    expect([...db.nodesByLabel('Document')]).toHaveLength(1);
  });

  it('MATCH ... MERGE runs once per row, reusing bound variables', async () => {
    await exec("CREATE (:Person {name: 'A'}), (:Person {name: 'B'})");
    await exec('MATCH (p:Person) MERGE (p)-[:HAS]->(:Profile)');
    expect([...db.nodesByLabel('Profile')]).toHaveLength(2);
    await exec('MATCH (p:Person) MERGE (p)-[:HAS]->(:Profile)'); // idempotent
    expect([...db.nodesByLabel('Profile')]).toHaveLength(2);
  });
});

describe('MERGE — constraint interaction', () => {
  it('a create-path MERGE violating a unique constraint raises CONSTRAINT_VIOLATION', async () => {
    await db.createIndex({ kind: 'unique', label: 'User', property: 'handle' });
    await exec("CREATE (:User {handle: 'ada', extra: 1})");
    // The full pattern {handle:'ada', extra:2} does not match (extra differs in match key? No —
    // MERGE matches on ALL inline props), so it tries to CREATE handle:'ada' -> violation.
    await expect(
      exec("MERGE (u:User {handle: 'ada', extra: 2})"),
    ).rejects.toMatchObject({ code: 'CONSTRAINT_VIOLATION' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/query/test/merge-exec.test.ts`
Expected: FAIL — MERGE throws "handled in Task 4".

- [ ] **Step 3: Implement**

In `packages/query/src/write.ts`, replace the `merge` case in `runClause` with a real implementation. MERGE matches the whole pattern against committed state **plus** elements created earlier in this same transaction (via the store — but tx-created nodes are not yet in the store until commit). For v1 correctness with atomicity, MERGE matches against the **committed store only** for the match attempt; this is consistent because each MERGE runs in its own logical step and the spec's match-or-create is defined over current graph state. Document this.

Add the MERGE matcher and creator:

```ts
import { matchBindings } from './exec.js';
import type { PathPattern } from './ast.js';

/** Build a read PathPattern that matches the MERGE pattern against the store. */
function mergeMatch(pat: PathPattern, ctx: WriteCtx, binding: Binding): Binding | null {
  // Constrain anonymous/new vars by giving them fresh names; keep already-bound vars.
  // Reuse matchBindings by constructing a single-pattern read with the merge pattern,
  // pre-seeding bound variables as equality filters on id.
  const execOpts: ExecOptions = {
    params: ctx.eval.params,
    source: ctx.eval.source,
    timeoutMs: 30_000,
    maxRows: 1_000_000,
  };
  // Bound variables (from a leading MATCH) become hard constraints: filter matches whose
  // corresponding element id equals the bound id.
  const candidates = matchBindings([pat], undefined, ctx.store, execOpts);
  for (const cand of candidates) {
    let ok = true;
    for (const [name, rec] of binding) {
      const got = cand.get(name);
      if (got && got.id !== rec.id) {
        ok = false;
        break;
      }
    }
    if (ok) {
      // Merge the candidate's new bindings into a copy of the row binding.
      const merged = new Map(binding);
      for (const [k, v] of cand) merged.set(k, v);
      return merged;
    }
  }
  return null;
}

function runMerge(
  clause: Extract<WriteClause, { clause: 'merge' }>,
  ctx: WriteCtx,
  binding: Binding,
): void {
  const matched = mergeMatch(clause.pattern, ctx, binding);
  if (matched !== null) {
    for (const [k, v] of matched) binding.set(k, v);
    applySet(clause.onMatch, ctx, binding);
  } else {
    createPattern(clause.pattern, ctx, binding);
    applySet(clause.onCreate, ctx, binding);
  }
}
```

Replace the `case 'merge':` body in `runClause` with `runMerge(clause, ctx, binding); return;`.

Caveat to document in code: `matchBindings` matches against the live store, which does not yet include nodes created earlier in the same uncommitted transaction. Within a single MERGE per row this is correct; chained MERGEs in one statement that depend on each other's just-created nodes are a known v1 limitation (note it in the AQL reference, Task 9).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/query/test/merge-exec.test.ts packages/query/test/write-exec.test.ts`
Expected: PASS — including the whole-pattern create (a new Ada) and the constraint violation.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(query): MERGE with whole-pattern match-or-create and ON CREATE/ON MATCH SET"
```

### Task 5: Schema DDL — parse + execute

**Files:**
- Modify: `packages/query/src/parser.ts` (implement `tryParseDdl`), create `packages/query/src/ddl.ts`
- Test: `packages/query/test/ddl.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/query/test/ddl.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '@atlas/core';
import { AqlError } from '../src/errors.js';
import { parseQuery } from '../src/parser.js';
import { runDdl } from '../src/ddl.js';

let dir: string;
let db: AtlasDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-ddl-'));
  db = await openDatabase(dir);
});
afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

function ddl(src: string) {
  const p = parseQuery(src);
  if (p.statement.type !== 'ddl') throw new Error(`expected ddl, got ${p.statement.type}`);
  return p.statement.statement;
}

describe('DDL parsing', () => {
  it('parses each index/constraint form', () => {
    expect(ddl('CREATE INDEX ON :Person(born)')).toMatchObject({
      stmt: 'createIndex',
      kind: 'property',
      label: 'Person',
      property: 'born',
    });
    expect(ddl('CREATE FULLTEXT INDEX ON :Document(title)')).toMatchObject({
      stmt: 'createIndex',
      kind: 'fulltext',
    });
    expect(ddl('CREATE UNIQUE CONSTRAINT ON :User(email)')).toMatchObject({
      stmt: 'createIndex',
      kind: 'unique',
    });
    expect(ddl('DROP INDEX ON :Person(born)')).toMatchObject({ stmt: 'dropIndex', kind: 'property' });
    expect(ddl('SHOW INDEXES')).toMatchObject({ stmt: 'showIndexes' });
    expect(ddl('SHOW CONSTRAINTS')).toMatchObject({ stmt: 'showConstraints' });
  });

  it('CREATE (node) is still a write, not DDL', () => {
    expect(parseQuery('CREATE (n:T) RETURN n').statement.type).toBe('write');
  });

  it('rejects malformed DDL with position', () => {
    let e: AqlError | undefined;
    try {
      parseQuery('CREATE INDEX ON Person(born)'); // missing colon
    } catch (err) {
      e = err as AqlError;
    }
    expect(e?.code).toBe('PARSE_ERROR');
  });
});

describe('DDL execution', () => {
  it('creates and drops indexes; SHOW lists them', async () => {
    await runDdl(ddl('CREATE INDEX ON :Person(born)'), db);
    await runDdl(ddl('CREATE UNIQUE CONSTRAINT ON :User(email)'), db);
    const shown = await runDdl(ddl('SHOW INDEXES'), db);
    expect(shown.rows.length).toBe(2);
    expect(shown.columns).toEqual(['kind', 'label', 'property']);
    const cons = await runDdl(ddl('SHOW CONSTRAINTS'), db);
    expect(cons.rows).toEqual([['unique', 'User', 'email']]);
    await runDdl(ddl('DROP INDEX ON :Person(born)'), db);
    expect((await runDdl(ddl('SHOW INDEXES'), db)).rows.length).toBe(1);
  });

  it('a created index actually accelerates and enforces', async () => {
    await runDdl(ddl('CREATE UNIQUE CONSTRAINT ON :User(email)'), db);
    await db.transact((tx) => void tx.createNode(['User'], { email: 'a@x' }));
    await expect(
      db.transact((tx) => void tx.createNode(['User'], { email: 'a@x' })),
    ).rejects.toMatchObject({ code: 'CONSTRAINT_VIOLATION' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/query/test/ddl.test.ts`
Expected: FAIL — `tryParseDdl` returns null; `ddl.js` missing.

- [ ] **Step 3: Implement the parser side**

In `packages/query/src/parser.ts`, replace the `tryParseDdl` stub. It must NOT consume tokens unless it is certain the statement is DDL (CREATE может be a write), so peek before committing:

```ts
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
  const ddlNext = n.type === 'keyword' && (n.value === 'INDEX' || n.value === 'FULLTEXT' || n.value === 'UNIQUE');
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
```

- [ ] **Step 4: Implement the executor**

`packages/query/src/ddl.ts`:

```ts
import type { AtlasDatabase, IndexDef } from '@atlas/core';
import type { DdlStatement } from './ast.js';

export interface DdlResult {
  columns: string[];
  rows: unknown[][];
}

export async function runDdl(stmt: DdlStatement, db: AtlasDatabase): Promise<DdlResult> {
  switch (stmt.stmt) {
    case 'createIndex': {
      const def: IndexDef = { kind: stmt.kind, label: stmt.label, property: stmt.property };
      await db.createIndex(def);
      return { columns: [], rows: [] };
    }
    case 'dropIndex': {
      const def: IndexDef = { kind: stmt.kind, label: stmt.label, property: stmt.property };
      await db.dropIndex(def);
      return { columns: [], rows: [] };
    }
    case 'showIndexes': {
      const rows = db
        .listIndexes()
        .map((d) => [d.kind, d.label, d.property])
        .sort((a, b) => a.join().localeCompare(b.join()));
      return { columns: ['kind', 'label', 'property'], rows };
    }
    case 'showConstraints': {
      const rows = db
        .listIndexes()
        .filter((d) => d.kind === 'unique')
        .map((d) => [d.kind, d.label, d.property]);
      return { columns: ['kind', 'label', 'property'], rows };
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run packages/query/test/ddl.test.ts packages/query/test/parser-write.test.ts`
Expected: PASS — DDL parses/executes and CREATE(node) still routes to writes.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(query): schema DDL parsing and execution (CREATE/DROP/SHOW)"
```

### Task 6: CALL algo.* — parse + execute

**Files:**
- Modify: `packages/query/src/parser.ts` (implement `parseCall`), create `packages/query/src/call.ts`
- Test: `packages/query/test/call.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/query/test/call.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '@atlas/core';
import { AqlError } from '../src/errors.js';
import { parseQuery } from '../src/parser.js';
import { runCall } from '../src/call.js';

let dir: string;
let db: AtlasDatabase;
let n: number[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-call-'));
  db = await openDatabase(dir);
  n = [];
  await db.transact((tx) => {
    n = Array.from({ length: 3 }, () => tx.createNode(['V'], {}));
    tx.createEdge('R', n[0]!, n[1]!);
    tx.createEdge('R', n[1]!, n[2]!);
    tx.createEdge('R', n[2]!, n[0]!);
  });
});
afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

function call(src: string) {
  const p = parseQuery(src);
  if (p.statement.type !== 'call') throw new Error(`expected call, got ${p.statement.type}`);
  return p.statement.statement;
}

describe('CALL parsing', () => {
  it('parses namespaced name, args, and YIELD with aliases', () => {
    const c = call('CALL algo.pagerank({damping: 0.85}) YIELD node, score');
    expect(c.name).toBe('algo.pagerank');
    expect(c.yields).toEqual([{ name: 'node' }, { name: 'score' }]);
    const c2 = call('CALL algo.shortestPath({from: $a, to: $b}) YIELD path AS p, cost');
    expect(c2.yields[0]).toEqual({ name: 'path', alias: 'p' });
  });

  it('rejects unknown algorithms and bad YIELD columns at execution', async () => {
    await expect(runCall(call('CALL algo.nope() YIELD x'), db, {})).rejects.toThrowError(AqlError);
  });
});

describe('CALL execution maps onto db.algo', () => {
  it('pagerank yields node + score for every node', async () => {
    const r = await runCall(call('CALL algo.pagerank() YIELD node, score'), db, {});
    expect(r.columns).toEqual(['node', 'score']);
    expect(r.rows).toHaveLength(3);
    expect(r.rows.reduce((s, row) => s + (row[1] as number), 0)).toBeCloseTo(1, 6);
  });

  it('shortestPath takes params and yields path + cost', async () => {
    const r = await runCall(
      call('CALL algo.shortestPath({from: $a, to: $b}) YIELD path AS p, cost'),
      db,
      { a: n[0], b: n[2] },
    );
    expect(r.columns).toEqual(['p', 'cost']);
    expect(r.rows[0]![1]).toBe(2); // a->b->c
  });

  it('components mode argument flows through', async () => {
    const r = await runCall(call("CALL algo.components({mode: 'strong'}) YIELD node, component"), db, {});
    expect(r.rows).toHaveLength(3);
    expect(new Set(r.rows.map((row) => row[1])).size).toBe(1); // one SCC (the 3-cycle)
  });

  it('YIELD selects/renames a subset of result columns', async () => {
    const r = await runCall(call('CALL algo.degree() YIELD node'), db, {});
    expect(r.columns).toEqual(['node']);
    expect(r.rows[0]).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/query/test/call.test.ts`
Expected: FAIL — `parseCall` throws "not yet implemented"; `call.js` missing.

- [ ] **Step 3: Implement the parser side**

In `packages/query/src/parser.ts`, replace the `parseCall` stub:

```ts
function parseCall(ts: TokenStream): CallStatement {
  const start = ts.expectKeyword('CALL');
  const head = ts.expectIdent('procedure namespace');
  let name = head.value;
  while (ts.takePunct('.')) name += '.' + ts.expectIdent('procedure name').value;
  ts.expectPunct('(');
  const args: Expr[] = [];
  if (!ts.atPunct(')')) {
    do {
      args.push(parseCallArg(ts));
    } while (ts.takePunct(','));
  }
  ts.expectPunct(')');
  const yields: { name: string; alias?: string }[] = [];
  if (ts.takeKeyword('YIELD')) {
    do {
      const col = ts.expectIdent('yield column');
      const alias = ts.takeKeyword('AS') ? ts.expectIdent('alias').value : undefined;
      yields.push({ name: col.value, alias });
    } while (ts.takePunct(','));
  }
  return { name, args, yields, pos: pos(start) };
}

/** CALL args are either bare expressions or a single {key: expr, ...} options map. */
function parseCallArg(ts: TokenStream): Expr {
  if (ts.atPunct('{')) {
    const open = ts.next();
    const entries: { property: string; value: Expr }[] = [];
    if (!ts.atPunct('}')) {
      do {
        const key = ts.expectIdent('option name');
        ts.expectPunct(':');
        entries.push({ property: key.value, value: parseExpression(ts) });
      } while (ts.takePunct(','));
    }
    ts.expectPunct('}');
    // Represent the options map as a list of [key,value] handled by call.ts.
    return { kind: 'list', items: entries.map((e) => ({
      kind: 'list',
      items: [{ kind: 'literal', value: e.property, pos: pos(open) }, e.value],
      pos: pos(open),
    })), pos: pos(open) };
  }
  return parseExpression(ts);
}
```

- [ ] **Step 4: Implement the executor**

`packages/query/src/call.ts`:

```ts
import type { AtlasDatabase, EdgeRecord, NodeRecord } from '@atlas/core';
import type { CallStatement, Expr } from './ast.js';
import { AqlError } from './errors.js';
import { evalExpr, type EvalContext, type RuntimeValue } from './eval.js';

export interface CallResult {
  columns: string[];
  rows: RuntimeValue[][];
}

/** Decode the options-map Expr produced by parseCallArg into a plain object. */
function decodeOptions(arg: Expr | undefined, ctx: EvalContext): Record<string, RuntimeValue> {
  if (!arg) return {};
  if (arg.kind !== 'list') throw new AqlError('RUNTIME_ERROR', 'CALL options must be a map', arg.pos, ctx.source);
  const out: Record<string, RuntimeValue> = {};
  for (const entry of arg.items) {
    if (entry.kind !== 'list' || entry.items.length !== 2) continue;
    const key = entry.items[0]!;
    const keyName = key.kind === 'literal' ? String(key.value) : '';
    out[keyName] = evalExpr(entry.items[1]!, new Map(), ctx);
  }
  return out;
}

type AlgoRunner = (db: AtlasDatabase, o: Record<string, RuntimeValue>) => Promise<Record<string, RuntimeValue>[]>;

/** Maps spec §5.2 CALL names to db.algo, normalizing each result to YIELDable column maps. */
const ALGOS: Record<string, AlgoRunner> = {
  'algo.pagerank': async (db, o) =>
    (await db.algo.pagerank({ damping: num(o.damping), iterations: num(o.iterations) })).map((r) => ({
      node: r.node,
      score: r.score,
    })),
  'algo.louvain': async (db, o) =>
    (await db.algo.louvain({ maxLevels: num(o.maxLevels) })).map((r) => ({ node: r.node, community: r.community })),
  'algo.components': async (db, o) =>
    (await db.algo.components({ mode: o.mode === 'strong' ? 'strong' : 'weak' })).map((r) => ({
      node: r.node,
      component: r.component,
    })),
  'algo.degree': async (db, o) =>
    (await db.algo.degree({ direction: dir(o.direction) })).map((r) => ({ node: r.node, score: r.score })),
  'algo.betweenness': async (db, o) =>
    (await db.algo.betweenness({ sampleK: num(o.sampleK) })).map((r) => ({ node: r.node, score: r.score })),
  'algo.shortestPath': async (db, o) => {
    const r = await db.algo.shortestPath({ from: reqId(o.from), to: reqId(o.to), weightProp: str(o.weightProp) });
    return r === null ? [] : [{ path: r.path as unknown as RuntimeValue, cost: r.cost }];
  },
  'algo.allShortestPaths': async (db, o) =>
    (await db.algo.allShortestPaths({ from: reqId(o.from), to: reqId(o.to) })).map((r) => ({
      path: r.path as unknown as RuntimeValue,
      cost: r.cost,
    })),
  'algo.bfs': async (db, o) =>
    (await db.algo.bfs({ from: reqId(o.from), type: str(o.type), maxDepth: num(o.maxDepth) })).map((r) => ({
      node: r.node,
      depth: r.depth,
    })),
  'algo.dfs': async (db, o) =>
    (await db.algo.dfs({ from: reqId(o.from), type: str(o.type), maxDepth: num(o.maxDepth) })).map((r) => ({
      node: r.node,
      depth: r.depth,
    })),
  'algo.topoSort': async (db, o) =>
    (await db.algo.topoSort({ type: str(o.type) })).map((r) => ({ node: r.node, order: r.order })),
  'algo.cycles': async (db, o) =>
    (await db.algo.cycles({ type: str(o.type) })).map((r) => ({ cycle: r.cycle as unknown as RuntimeValue })),
};

function num(v: RuntimeValue): number | undefined {
  return typeof v === 'number' ? v : undefined;
}
function str(v: RuntimeValue): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function dir(v: RuntimeValue): 'out' | 'in' | 'both' | undefined {
  return v === 'out' || v === 'in' || v === 'both' ? v : undefined;
}
function reqId(v: RuntimeValue): number {
  if (typeof v === 'number') return v;
  if (v !== null && typeof v === 'object' && 'id' in v) return (v as NodeRecord | EdgeRecord).id;
  throw new Error('expected a node id argument');
}

export async function runCall(
  stmt: CallStatement,
  db: AtlasDatabase,
  params: Record<string, unknown>,
): Promise<CallResult> {
  const runner = ALGOS[stmt.name];
  if (!runner) throw new AqlError('SEMANTIC_ERROR', `unknown procedure "${stmt.name}"`, stmt.pos, '');
  const ctx: EvalContext = { params, source: '' };
  const options = decodeOptions(stmt.args[0], ctx);
  let results: Record<string, RuntimeValue>[];
  try {
    results = await runner(db, options);
  } catch (e) {
    if (e instanceof AqlError) throw e;
    throw new AqlError('RUNTIME_ERROR', `${stmt.name}: ${(e as Error).message}`, stmt.pos, '');
  }
  const cols = stmt.yields.length > 0 ? stmt.yields : inferColumns(results);
  for (const y of cols)
    if (results.length > 0 && !(y.name in results[0]!))
      throw new AqlError('SEMANTIC_ERROR', `procedure "${stmt.name}" does not yield "${y.name}"`, stmt.pos, '');
  const columns = cols.map((y) => y.alias ?? y.name);
  const rows = results.map((r) => cols.map((y) => r[y.name] ?? null));
  return { columns, rows };
}

function inferColumns(results: Record<string, RuntimeValue>[]): { name: string }[] {
  return results.length === 0 ? [] : Object.keys(results[0]!).map((name) => ({ name }));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run packages/query/test/call.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(query): CALL algo.* mapping onto db.algo with YIELD projection"
```

### Task 7: API integration + EXPLAIN for all statement types

**Files:**
- Modify: `packages/query/src/api.ts`, `packages/query/src/plan.ts`
- Test: `packages/query/test/api-write.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/query/test/api-write.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '@atlas/core';
import { executeQuery } from '../src/api.js';

let dir: string;
let db: AtlasDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-apiw-'));
  db = await openDatabase(dir);
});
afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('executeQuery routes every statement type', () => {
  it('runs a write and persists, returning RETURN rows + stats', async () => {
    const r = await executeQuery(db, "CREATE (n:Person {name: 'Ada'}) RETURN n.name AS name");
    expect(r.rows).toEqual([['Ada']]);
    expect(r.stats.created).toBe(1);
    // persisted across a fresh read:
    const read = await executeQuery(db, 'MATCH (p:Person) RETURN count(*) AS c');
    expect(read.rows).toEqual([[1]]);
  });

  it('runs DDL and reflects it in subsequent reads', async () => {
    await executeQuery(db, 'CREATE INDEX ON :Person(born)');
    const shown = await executeQuery(db, 'SHOW INDEXES');
    expect(shown.rows).toEqual([['property', 'Person', 'born']]);
  });

  it('runs CALL and returns yielded columns', async () => {
    await executeQuery(db, "CREATE (a:V)-[:R]->(b:V), (b)-[:R]->(a)");
    const r = await executeQuery(db, 'CALL algo.degree() YIELD node, score');
    expect(r.columns).toEqual(['node', 'score']);
    expect(r.rows).toHaveLength(2);
  });

  it('EXPLAIN works for write, DDL, and CALL without executing them', async () => {
    const w = await executeQuery(db, "EXPLAIN CREATE (n:Person {name: 'X'}) RETURN n");
    expect(w.columns).toEqual(['plan']);
    expect(JSON.stringify(w.rows[0]![0])).toContain('Create');
    expect([...db.nodesByLabel('Person')]).toHaveLength(0); // not executed

    const d = await executeQuery(db, 'EXPLAIN CREATE INDEX ON :Person(born)');
    expect(JSON.stringify(d.rows[0]![0])).toContain('createIndex');
    expect(db.listIndexes()).toHaveLength(0); // not executed

    const c = await executeQuery(db, 'EXPLAIN CALL algo.pagerank() YIELD node, score');
    expect(JSON.stringify(c.rows[0]![0])).toContain('algo.pagerank');
  });

  it('a failing write rolls back fully', async () => {
    await executeQuery(db, "CREATE (a:Linked)-[:R]->(b:Linked)");
    await expect(
      executeQuery(db, 'MATCH (a:Linked)-[:R]->(b) CREATE (:Extra) DELETE a'),
    ).rejects.toThrow();
    const extras = await executeQuery(db, 'MATCH (e:Extra) RETURN count(*) AS c');
    expect(extras.rows).toEqual([[0]]);
  });

  it('errors keep AqlError positions through the public API', async () => {
    await expect(executeQuery(db, 'CREATE (n:T SET n.x = 1')).rejects.toMatchObject({
      code: 'PARSE_ERROR',
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/query/test/api-write.test.ts`
Expected: FAIL — `api.ts` still reads `parsed.query` (old shape) and has no write/ddl/call routing.

- [ ] **Step 3: Implement EXPLAIN serialization for write/ddl/call**

In `packages/query/src/plan.ts`, add lightweight plan-description builders (no executor coupling — these are display-only for EXPLAIN):

```ts
import type { CallStatement, DdlStatement, WriteQuery } from './ast.js';

export function describeWritePlan(q: WriteQuery): Record<string, unknown> {
  const steps: Record<string, unknown>[] = [];
  if (q.readMatch) steps.push({ op: 'Match', patterns: q.readMatch.patterns.length });
  for (const c of q.clauses) {
    if (c.clause === 'create') steps.push({ op: 'Create', patterns: c.patterns.length });
    else if (c.clause === 'merge') steps.push({ op: 'Merge', onCreate: c.onCreate.length, onMatch: c.onMatch.length });
    else if (c.clause === 'set') steps.push({ op: 'SetProps', items: c.items.length });
    else if (c.clause === 'remove') steps.push({ op: 'RemoveProps', items: c.items.length });
    else steps.push({ op: 'Delete', detach: c.detach, targets: c.targets.length });
  }
  if (q.returnItems) steps.push({ op: 'Project', columns: q.returnItems.length });
  return { op: 'Write', steps };
}

export function describeDdlPlan(s: DdlStatement): Record<string, unknown> {
  return { op: 'Ddl', ...s };
}

export function describeCallPlan(s: CallStatement): Record<string, unknown> {
  return { op: 'Call', name: s.name, yields: s.yields.map((y) => y.alias ?? y.name) };
}
```

- [ ] **Step 4: Rewrite `executeQuery` to route**

Replace `packages/query/src/api.ts`'s `executeQuery` and `explainQuery`:

```ts
import type { AtlasDatabase } from '@atlas/core';
import { runCall } from './call.js';
import { runDdl } from './ddl.js';
import { runRead } from './exec.js';
import { parseQuery } from './parser.js';
import { describeCallPlan, describeDdlPlan, describeWritePlan, serializePlan } from './plan.js';
import { planQuery } from './planner.js';
import { runWrite } from './write.js';

export interface QueryOptions {
  params?: Record<string, unknown>;
  timeoutMs?: number;
  maxRows?: number;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  stats: { rowsExamined: number; elapsedMs: number; created?: number; deleted?: number; propsSet?: number };
}

export async function executeQuery(
  db: AtlasDatabase,
  text: string,
  opts: QueryOptions = {},
): Promise<QueryResult> {
  const started = performance.now();
  const params = opts.params ?? {};
  const parsed = parseQuery(text);
  const ms = (): number => Math.round(performance.now() - started);

  if (parsed.explain) {
    const plan =
      parsed.statement.type === 'read'
        ? serializePlan(planQuery(parsed.statement.query, db.graphStore))
        : parsed.statement.type === 'write'
          ? describeWritePlan(parsed.statement.query)
          : parsed.statement.type === 'ddl'
            ? describeDdlPlan(parsed.statement.statement)
            : describeCallPlan(parsed.statement.statement);
    return { columns: ['plan'], rows: [[plan]], stats: { rowsExamined: 0, elapsedMs: ms() } };
  }

  switch (parsed.statement.type) {
    case 'read': {
      const query = parsed.statement.query;
      const plan = planQuery(query, db.graphStore);
      const result = runRead(plan, query, db.graphStore, {
        params,
        source: text,
        timeoutMs: opts.timeoutMs ?? 30_000,
        maxRows: opts.maxRows ?? 100_000,
      });
      return { columns: result.columns, rows: result.rows, stats: { rowsExamined: result.stats.rowsExamined, elapsedMs: ms() } };
    }
    case 'write': {
      const query = parsed.statement.query;
      let out = { columns: [] as string[], rows: [] as unknown[][], stats: { created: 0, deleted: 0, propsSet: 0 } };
      await db.transact((tx) => {
        out = runWrite(query, db.graphStore, tx, { params, source: text });
      });
      return {
        columns: out.columns,
        rows: out.rows,
        stats: { rowsExamined: 0, elapsedMs: ms(), ...out.stats },
      };
    }
    case 'ddl': {
      const r = await runDdl(parsed.statement.statement, db);
      return { columns: r.columns, rows: r.rows, stats: { rowsExamined: 0, elapsedMs: ms() } };
    }
    case 'call': {
      const r = await runCall(parsed.statement.statement, db, params);
      return { columns: r.columns, rows: r.rows, stats: { rowsExamined: 0, elapsedMs: ms() } };
    }
  }
}

export function explainQuery(db: AtlasDatabase, text: string): Record<string, unknown> {
  const parsed = parseQuery(text);
  if (parsed.statement.type === 'read') return serializePlan(planQuery(parsed.statement.query, db.graphStore));
  if (parsed.statement.type === 'write') return describeWritePlan(parsed.statement.query);
  if (parsed.statement.type === 'ddl') return describeDdlPlan(parsed.statement.statement);
  return describeCallPlan(parsed.statement.statement);
}
```

- [ ] **Step 5: Run tests + full gate to verify the build is green again**

Run: `pnpm vitest run packages/query/test/api-write.test.ts packages/query/test/api.test.ts && pnpm build && pnpm typecheck:test && pnpm lint && pnpm format`
Expected: PASS and green — `api.ts` now consumes the new `parsed.statement` shape, restoring the build that was red since Task 1.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(query): route read/write/DDL/CALL through executeQuery with EXPLAIN"
```

### Task 8: End-to-end coverage over science-history + exports + reference doc + gate

**Files:**
- Modify: `packages/query/src/index.ts`, `README.md`
- Create: `docs/aql-reference.md`, `packages/query/test/e2e.test.ts`

- [ ] **Step 1: Write the end-to-end test**

`packages/query/test/e2e.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type AtlasDatabase } from '@atlas/core';
import { loadDataset, scienceHistory } from '@atlas/datasets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeQuery } from '../src/api.js';

let dir: string;
let db: AtlasDatabase;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-e2e-'));
  db = await openDatabase(dir, { fsync: { intervalMs: 1000 } });
  await loadDataset(db, scienceHistory());
});
afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('AQL end-to-end on science-history', () => {
  it('read + write round trip: tag prolific authors, then query the tag', async () => {
    await executeQuery(db, 'CREATE INDEX ON :Person(name)');
    const w = await executeQuery(
      db,
      "MATCH (p:Person)-[:WROTE]->(d:Document) WITH p RETURN p.name AS name, count(d) AS works".replace(
        'WITH p ',
        '',
      ),
    );
    expect(w.rows.length).toBeGreaterThan(0);

    await executeQuery(db, "MATCH (p:Person {name: 'Ada Lovelace'}) SET p.featured = true");
    const featured = await executeQuery(
      db,
      'MATCH (p:Person) WHERE p.featured = true RETURN p.name AS name',
    );
    expect(featured.rows).toEqual([['Ada Lovelace']]);
  });

  it('MERGE is idempotent across repeated runs', async () => {
    const before = (await executeQuery(db, 'MATCH (t:Topic) RETURN count(*) AS c')).rows[0]![0];
    for (let i = 0; i < 3; i++)
      await executeQuery(db, "MERGE (t:Topic {name: 'Computing'})");
    const after = (await executeQuery(db, 'MATCH (t:Topic) RETURN count(*) AS c')).rows[0]![0];
    expect(after).toBe((before as number) + 1);
  });

  it('CALL pagerank then read top nodes back', async () => {
    const r = await executeQuery(db, 'CALL algo.pagerank() YIELD node, score');
    expect(r.rows.length).toBe(500);
    expect(r.rows.reduce((s, row) => s + (row[1] as number), 0)).toBeCloseTo(1, 4);
  });

  it('DELETE removes and stays deleted', async () => {
    await executeQuery(db, "CREATE (:Scratch {id: 1}), (:Scratch {id: 2})");
    await executeQuery(db, 'MATCH (s:Scratch) DELETE s');
    expect((await executeQuery(db, 'MATCH (s:Scratch) RETURN count(*) AS c')).rows).toEqual([[0]]);
  });
});
```

Note: if the `WITH`-strip hack reads awkwardly, just write the query plainly as `MATCH (p:Person)-[:WROTE]->(d:Document) RETURN p.name AS name, count(d) AS works` — `WITH` is not in scope for M4, the `.replace` is only there to make that explicit; the implementer should use the plain query and delete the comment.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/query/test/e2e.test.ts`
Expected: FAIL — likely on imports until exports are finalized; fix and iterate.

- [ ] **Step 3: Finalize exports**

In `packages/query/src/index.ts`, add the M4b public surface (append to the existing exports):

```ts
export { runWrite, type WriteResult } from './write.js';
export { runDdl, type DdlResult } from './ddl.js';
export { runCall, type CallResult } from './call.js';
export {
  describeCallPlan,
  describeDdlPlan,
  describeWritePlan,
} from './plan.js';
export type {
  CallStatement,
  DdlStatement,
  SetItem,
  RemoveItem,
  Statement,
  WriteClause,
  WriteQuery,
} from './ast.js';
```

- [ ] **Step 4: Write the AQL reference doc**

`docs/aql-reference.md`:

```markdown
# AQL — Atlas Query Language Reference

AQL is Atlas's Cypher-like query language. Every statement runs through
`executeQuery(db, text, { params, timeoutMs, maxRows })`. Prefix any statement
with `EXPLAIN` to get its plan as JSON instead of executing it.

## Reads

    MATCH (p:Person)-[:WROTE]->(d:Document)
    WHERE d.year > 1840 AND p.name CONTAINS 'lovelace'
    RETURN p.name, count(d) AS works
    ORDER BY works DESC SKIP 0 LIMIT 10

- **Patterns:** node `(v:Label {prop: value})`, edges `-[:TYPE]->`, `<-[:TYPE]-`,
  `-[:A|B]-` (multi-type, undirected), variable-length `-[:TYPE*1..3]->`
  (default `*` = 1..8, max 15; no edge variable).
- **WHERE:** `= <> < <= > >=`, `AND OR NOT`, `CONTAINS`, `STARTS WITH`,
  `ENDS WITH`, `IN [..]`, `EXISTS(v.prop)`.
- **RETURN:** projections, `AS` aliases, `DISTINCT`, aggregates `count`,
  `collect`, `sum`, `avg`, `min`, `max` (implicit grouping by the non-aggregate
  items), scalar `id(v)`, `labels(n)`, `type(e)`.
- **Tail:** `ORDER BY ... [ASC|DESC]`, `SKIP n`, `LIMIT n` (integer or `$param`).

## Null & equality semantics (v1)

Comparisons involving a missing/`NULL` value are `false` (not three-valued).
Equality is type-strict: `1 = '1'` is false. Use `EXISTS(v.prop)` to test
presence.

## Writes

    CREATE (a:Person {name: 'Ada'})-[:WROTE]->(d:Document {title: 'Notes'})
    MATCH (p:Person) SET p.active = true REMOVE p.tmp
    MATCH (p:Person {name: 'Ada'}) DETACH DELETE p

- **CREATE** builds nodes/edges; edges need exactly one type and a direction.
- **SET** `v.prop = expr` (multiple comma-separated); setting `NULL` removes the
  property. **REMOVE** `v.prop` deletes a property.
- **DELETE v** removes an edgeless node or an edge; **DETACH DELETE v** removes a
  node and all its edges.
- A leading `MATCH` runs the write once per matched row. A trailing `RETURN`
  projects the post-write bindings.
- Every statement is atomic: any error rolls back the whole statement.

## MERGE

    MERGE (p:Person {email: $e})
      ON CREATE SET p.created = $now
      ON MATCH  SET p.seen = $now

MERGE matches the **whole pattern**; if no complete match exists it creates the
entire pattern (matching some elements and creating others is never partial).
`ON CREATE SET` runs only when created, `ON MATCH SET` only when matched. A
create that violates a unique constraint raises `CONSTRAINT_VIOLATION`.

*v1 limitation:* MERGE matches against committed state; chained MERGEs in one
statement do not see each other's just-created nodes.

## Schema DDL

    CREATE INDEX ON :Person(born)
    CREATE FULLTEXT INDEX ON :Document(title)
    CREATE UNIQUE CONSTRAINT ON :User(email)
    DROP INDEX ON :Person(born)
    SHOW INDEXES
    SHOW CONSTRAINTS

## Algorithms

    CALL algo.pagerank({damping: 0.85, iterations: 20}) YIELD node, score
    CALL algo.shortestPath({from: $a, to: $b, weightProp: 'w'}) YIELD path, cost
    CALL algo.components({mode: 'strong'}) YIELD node, component

Available: `pagerank`, `louvain`, `components`, `degree`, `betweenness`,
`shortestPath`, `allShortestPaths`, `bfs`, `dfs`, `topoSort`, `cycles`. `YIELD`
selects and optionally renames result columns. See the §5.2 signature table for
each procedure's options and yielded columns.

## Errors

Parse, semantic, and runtime errors are `AqlError` with `code`, `message`,
`line`, `column`, and a caret `snippet`. Runtime guards raise `TIMEOUT`
(per-query budget) and `ROW_LIMIT` (max rows) rather than truncating.
```

- [ ] **Step 5: Update README + run the full gate**

In `README.md`, set the `**Status:**` block to:

```markdown
**Status:** M4 complete — full AQL (`@atlas/query`): reads (MATCH/WHERE/RETURN,
aggregations, variable-length paths), writes (CREATE/MERGE/SET/REMOVE/DELETE),
schema DDL, and `CALL algo.*`, all atomic and EXPLAIN-able. See
`docs/aql-reference.md`.
```

Run: `pnpm build && pnpm typecheck:test && pnpm lint && pnpm format && pnpm test`
Expected: all green across all four packages.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(query): M4b end-to-end coverage, exports, AQL reference doc"
```

---

## Plan self-review notes

- **Spec coverage (§5.2 write surface):** CREATE → T3; MERGE whole-pattern + ON CREATE/ON MATCH SET + constraint interaction → T4; SET/REMOVE/DELETE/DETACH DELETE → T3; schema DDL (CREATE/DROP INDEX·FULLTEXT·UNIQUE, SHOW INDEXES/CONSTRAINTS) → T5; `CALL algo.* YIELD` over the §5.2 table → T6; atomic execution inside `db.transact` → T3/T7; EXPLAIN for write/DDL/CALL → T7; AqlError positions preserved throughout; AQL reference doc → T8.
- **Deliberate v1 scope (documented, not gaps):** no `WITH` chaining (stated in T8); MERGE matches committed state only (chained-MERGE caveat documented in code + reference); `SET v += map` and `SET v:Label` (label mutation) out of scope — only `v.prop = expr`; CREATE edges must be single-typed and directed; CALL options passed as a single `{...}` map; DDL authorization (owner-only) is deferred to M5 (server) — here DDL just executes.
- **Type/shape anchors:** `parseQuery → { explain, statement }` where `statement` is the `Statement` union (this REPLACES M4a's `{ explain, query }` — the build is intentionally red from Task 1 until Task 7 updates `api.ts`, called out in both tasks); `runWrite(query, store, tx, {params, source}) → WriteResult`; `runDdl(stmt, db) → DdlResult`; `runCall(stmt, db, params) → CallResult`; writes drive `TxBuilder`; `matchBindings` (exported from exec.ts in T3) reuses the M4a binding engine via a `collectBindings` refactor that must keep all M4a exec tests green.
- **Self-review fixes applied:** removed a `binding.__final` hack from the write executor in favor of a parallel `finals[]` array (noted inline in T3); flagged that freshly-created records must be re-read from the store before RETURN projects their props (T3); ensured `tryParseDdl` peeks without consuming so `CREATE (node)` still routes to the write parser (T5).


