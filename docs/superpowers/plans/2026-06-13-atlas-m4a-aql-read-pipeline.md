# Atlas M4a — AQL Read Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@atlas/query` — the read half of AQL: position-tracked lexer, recursive-descent parser (MATCH patterns incl. variable-length hops, WHERE, RETURN with aggregations, ORDER BY/SKIP/LIMIT, `$parameters`), a selectivity-based planner with `EXPLAIN` JSON, and a synchronous executor compiled onto core's store and indexes, guarded by per-query timeout and max-rows limits, with caret-annotated errors.

**Architecture:** Pure-function pipeline: `lex → parse (AST) → validate → plan (logical PlanNode tree) → execute (generator pipeline over GraphStore)`. Every stage is independently unit-testable; only `execute` touches a database. Reads are fully synchronous (no lease needed — `applyBatch` is synchronous, so sync iteration is point-in-time by construction); guards check row counts every iteration and the clock every 1024 rows. Writes, DDL, and `CALL algo.*` are **M4b — explicitly out of scope here** (the parser rejects them with PARSE_ERROR for now).

**Tech Stack:** Existing stack. New workspace package `packages/query` (`@atlas/query`) depending only on `@atlas/core`. No external parser libraries — the lexer and recursive-descent parser are hand-built per spec §5.3.

**Spec:** `docs/superpowers/specs/2026-06-10-atlas-graph-platform-design.md` §5.2 (AQL surface), §5.3 (pipeline as pure function), §5.4 (errors with `{code, message, line, column, snippet}` + runtime guards), §3 (layering: query depends on core only).

**Existing code anchors:** `GraphStore` public surface (`nodes`, `nodesByLabel`, `labelCount`, `outEdges/inEdges`, `indexes.has/lookupExact/lookupRange`) in `packages/core/src/store.ts` and `src/index/registry.ts`; `AtlasDatabase` in `src/database.ts` (the `store` field is private — Task 1 adds a read-only `graphStore` accessor); `NodeRecord`/`EdgeRecord`/`Props` in `src/types.ts`.

---

## File structure

```
packages/query/
  package.json              @atlas/query (dep: @atlas/core workspace:*)
  tsconfig.json             composite, references ../core
  test/tsconfig.json        noEmit typecheck for tests
  src/index.ts              public exports
  src/errors.ts             AqlError {code,message,line,column,snippet} + renderSnippet
  src/lexer.ts              lex(source) -> Token[] (keywords, idents, params, numbers, strings, puncts)
  src/ast.ts                Expr/NodePattern/EdgePattern/PathPattern/ReadQuery types + AGGREGATES
  src/parser.ts             recursive-descent parser + semantic validation (one cohesive grammar unit)
  src/eval.ts               evalExpr + compareRuntime + truthiness/null rules
  src/plan.ts               PlanNode types (JSON-serializable) — the EXPLAIN payload
  src/planner.ts            start-point selection by selectivity, expand chains, joins, top operators
  src/exec.ts               generator-pipeline executor over GraphStore + Guard (timeout/maxRows)
  src/api.ts                executeQuery(db, text, opts) / explain(db, text, opts)
  test/lexer.test.ts, parser.test.ts, eval.test.ts, planner.test.ts,
  test/exec-basic.test.ts, exec-patterns.test.ts, exec-aggregate.test.ts, api.test.ts

packages/core/src/database.ts   MODIFY (Task 1): graphStore accessor
tsconfig.json                   MODIFY: references += packages/query
package.json                    MODIFY: typecheck:test += query test tsconfig
README.md                       MODIFY (Task 11)
```

Conventions carried from M0–M3: ESM imports use `.js` extensions; commits end with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; never run bare `vitest` (always `pnpm vitest run`). All positions are 1-based (line and column).

---

### Task 1: Package scaffold, AqlError, core `graphStore` accessor

**Files:**
- Create: `packages/query/package.json`, `packages/query/tsconfig.json`, `packages/query/test/tsconfig.json`, `packages/query/src/index.ts`, `packages/query/src/errors.ts`
- Modify: `tsconfig.json` (root), `package.json` (root), `packages/core/src/database.ts`
- Test: `packages/query/test/errors.test.ts`

- [ ] **Step 1: Write the package files**

`packages/query/package.json`:

```json
{
  "name": "@atlas/query",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./dist/index.js" },
  "types": "./dist/index.d.ts",
  "dependencies": { "@atlas/core": "workspace:*" }
}
```

`packages/query/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"],
  "references": [{ "path": "../core" }]
}
```

`packages/query/test/tsconfig.json` (same shape as the existing core/datasets test tsconfigs):

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "composite": false,
    "noEmit": true,
    "declaration": false,
    "declarationMap": false,
    "sourceMap": false,
    "types": ["node"]
  },
  "include": ["./**/*.ts", "../src/**/*.ts"]
}
```

Root `tsconfig.json` references gains `{ "path": "packages/query" }`. Root `package.json` `typecheck:test` script gains ` && tsc -p packages/query/test/tsconfig.json`.

`packages/query/src/index.ts` (placeholder; Task 11 finalizes):

```ts
export { AqlError, renderSnippet, type AqlErrorCode } from './errors.js';
```

- [ ] **Step 2: Write the failing tests**

`packages/query/test/errors.test.ts`:

```ts
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
    const e = new AqlError('PARSE_ERROR', 'unexpected token ">>"', { line: 2, column: 14 },
      'MATCH (p)\nWHERE p.x >> 1\nRETURN p');
    expect(e.code).toBe('PARSE_ERROR');
    expect(e.line).toBe(2);
    expect(e.column).toBe(14);
    expect(e.snippet).toContain('^');
    expect(e.name).toBe('AqlError');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm install && pnpm vitest run packages/query/test/errors.test.ts`
Expected: FAIL — `../src/errors.js` not found.

- [ ] **Step 4: Implement**

`packages/query/src/errors.ts`:

```ts
export type AqlErrorCode = 'PARSE_ERROR' | 'SEMANTIC_ERROR' | 'RUNTIME_ERROR' | 'TIMEOUT' | 'ROW_LIMIT';

/** Caret rendering: the offending source line, then a `^` under the 1-based column. */
export function renderSnippet(source: string, line: number, column: number): string {
  const lines = source.split('\n');
  const idx = Math.min(Math.max(line, 1), lines.length) - 1;
  const text = lines[idx] ?? '';
  const col = Math.min(Math.max(column, 1), text.length + 1);
  return `${text}\n${' '.repeat(col - 1)}^`;
}

export class AqlError extends Error {
  readonly line: number;
  readonly column: number;
  readonly snippet: string;

  constructor(
    readonly code: AqlErrorCode,
    message: string,
    pos: { line: number; column: number },
    source: string,
  ) {
    super(message);
    this.name = 'AqlError';
    this.line = pos.line;
    this.column = pos.column;
    this.snippet = renderSnippet(source, pos.line, pos.column);
  }
}
```

In `packages/core/src/database.ts`, add next to the `algo` getter (with its import style):

```ts
  /**
   * Read-only handle to the committed store, for query engines layered on
   * core (@atlas/query). Mutating through it bypasses the WAL — never write.
   */
  get graphStore(): GraphStore {
    return this.store;
  }
```

(`GraphStore` is already imported in database.ts via the store field's type — if it is a type-only import, that suffices.)

- [ ] **Step 5: Run tests + gate to verify**

Run: `pnpm vitest run packages/query/test/errors.test.ts && pnpm build && pnpm typecheck:test`
Expected: PASS; whole solution builds with the new project reference.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(query): package scaffold, AqlError with caret snippets, core graphStore accessor"
```

### Task 2: Lexer

**Files:**
- Create: `packages/query/src/lexer.ts`
- Test: `packages/query/test/lexer.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/query/test/lexer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AqlError } from '../src/errors.js';
import { lex } from '../src/lexer.js';

function kinds(src: string): string[] {
  return lex(src).map((t) => `${t.type}:${t.value}`);
}

describe('lex', () => {
  it('tokenizes a representative read query with positions', () => {
    const toks = lex("MATCH (p:Person)-[:WROTE]->(d)\nWHERE d.year >= 1840\nRETURN p.name AS author");
    expect(toks.at(-1)!.type).toBe('eof');
    const where = toks.find((t) => t.value === 'WHERE')!;
    expect(where.type).toBe('keyword');
    expect(where.line).toBe(2);
    expect(where.column).toBe(1);
    const ge = toks.find((t) => t.value === '>=')!;
    expect(ge.type).toBe('punct');
    expect(ge.line).toBe(2);
  });

  it('keywords are case-insensitive and normalized; identifiers keep case', () => {
    expect(kinds('match Person RETURN aS')).toEqual([
      'keyword:MATCH',
      'ident:Person',
      'keyword:RETURN',
      'keyword:AS',
      'eof:',
    ]);
  });

  it('lexes strings with both quote styles and escapes', () => {
    const toks = lex(`RETURN 'it\\'s', "two\\nlines", 'tab\\t'`);
    const strs = toks.filter((t) => t.type === 'string').map((t) => t.value);
    expect(strs).toEqual(["it's", 'two\nlines', 'tab\t']);
  });

  it('lexes numbers, params, and multi-char puncts greedily', () => {
    expect(kinds('$min <= 3.5 <> 2 .. ->')).toEqual([
      'param:min',
      'punct:<=',
      'number:3.5',
      'punct:<>',
      'number:2',
      'punct:..',
      'punct:->',
      'eof:',
    ]);
  });

  it('skips // comments to end of line', () => {
    expect(kinds('RETURN 1 // trailing\n// whole line\nRETURN 2').filter((k) => k !== 'eof:')).toEqual([
      'keyword:RETURN',
      'number:1',
      'keyword:RETURN',
      'number:2',
    ]);
  });

  it('reports bad characters and unterminated strings with positions', () => {
    try {
      lex('RETURN ^');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AqlError);
      expect((e as AqlError).code).toBe('PARSE_ERROR');
      expect((e as AqlError).column).toBe(8);
    }
    expect(() => lex("RETURN 'open")).toThrowError(AqlError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/query/test/lexer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/query/src/lexer.ts`:

```ts
import { AqlError } from './errors.js';

export type TokenType = 'keyword' | 'ident' | 'param' | 'number' | 'string' | 'punct' | 'eof';

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  column: number;
}

const KEYWORDS = new Set([
  'MATCH', 'WHERE', 'RETURN', 'AS', 'DISTINCT', 'ORDER', 'BY', 'SKIP', 'LIMIT',
  'ASC', 'DESC', 'AND', 'OR', 'NOT', 'IN', 'CONTAINS', 'STARTS', 'ENDS', 'WITH',
  'EXISTS', 'NULL', 'TRUE', 'FALSE', 'EXPLAIN',
]);

const MULTI_PUNCTS = ['<=', '>=', '<>', '->', '<-', '..'];
const SINGLE_PUNCTS = new Set(['(', ')', '[', ']', '{', '}', ':', ',', '.', '=', '<', '>', '-', '*', '|']);
const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const ESCAPES: Record<string, string> = { n: '\n', t: '\t', '\\': '\\', "'": "'", '"': '"' };

export function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let column = 1;

  const fail = (msg: string, l = line, c = column): never => {
    throw new AqlError('PARSE_ERROR', msg, { line: l, column: c }, source);
  };
  const advance = (n = 1): void => {
    for (let k = 0; k < n; k++) {
      if (source[i] === '\n') {
        line++;
        column = 1;
      } else {
        column++;
      }
      i++;
    }
  };

  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      advance();
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') advance();
      continue;
    }
    const startLine = line;
    const startCol = column;
    if (IDENT_START.test(ch)) {
      let j = i;
      while (j < source.length && IDENT_PART.test(source[j]!)) j++;
      const raw = source.slice(i, j);
      const upper = raw.toUpperCase();
      advance(raw.length);
      tokens.push(
        KEYWORDS.has(upper)
          ? { type: 'keyword', value: upper, line: startLine, column: startCol }
          : { type: 'ident', value: raw, line: startLine, column: startCol },
      );
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      if (j >= source.length || !IDENT_START.test(source[j]!)) fail('expected parameter name after "$"');
      while (j < source.length && IDENT_PART.test(source[j]!)) j++;
      const name = source.slice(i + 1, j);
      advance(j - i);
      tokens.push({ type: 'param', value: name, line: startLine, column: startCol });
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      let j = i;
      while (j < source.length && source[j]! >= '0' && source[j]! <= '9') j++;
      // ".." after a number is a range punct, not a decimal point.
      if (source[j] === '.' && source[j + 1] !== '.' && source[j + 1]! >= '0' && source[j + 1]! <= '9') {
        j++;
        while (j < source.length && source[j]! >= '0' && source[j]! <= '9') j++;
      }
      const raw = source.slice(i, j);
      advance(raw.length);
      tokens.push({ type: 'number', value: raw, line: startLine, column: startCol });
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let out = '';
      for (;;) {
        if (j >= source.length) fail('unterminated string', startLine, startCol);
        const c = source[j]!;
        if (c === '\\') {
          const esc = ESCAPES[source[j + 1] ?? ''];
          if (esc === undefined) fail(`unknown escape "\\${source[j + 1] ?? ''}"`, startLine, startCol);
          out += esc;
          j += 2;
          continue;
        }
        if (c === ch) break;
        out += c;
        j++;
      }
      advance(j + 1 - i);
      tokens.push({ type: 'string', value: out, line: startLine, column: startCol });
      continue;
    }
    const two = source.slice(i, i + 2);
    if (MULTI_PUNCTS.includes(two)) {
      advance(2);
      tokens.push({ type: 'punct', value: two, line: startLine, column: startCol });
      continue;
    }
    if (SINGLE_PUNCTS.has(ch)) {
      advance();
      tokens.push({ type: 'punct', value: ch, line: startLine, column: startCol });
      continue;
    }
    fail(`unexpected character "${ch}"`);
  }
  tokens.push({ type: 'eof', value: '', line, column });
  return tokens;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/query/test/lexer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(query): position-tracked AQL lexer"
```

### Task 3: AST types + expression parser

**Files:**
- Create: `packages/query/src/ast.ts`, `packages/query/src/parser.ts` (TokenStream + expression grammar; Task 4 appends the query grammar to this file)
- Test: `packages/query/test/expr-parser.test.ts`

- [ ] **Step 1: Write the AST module**

`packages/query/src/ast.ts`:

```ts
export interface Pos {
  line: number;
  column: number;
}

export type Expr =
  | { kind: 'literal'; value: string | number | boolean | null; pos: Pos }
  | { kind: 'param'; name: string; pos: Pos }
  | { kind: 'variable'; name: string; pos: Pos }
  | { kind: 'prop'; target: string; property: string; pos: Pos }
  | { kind: 'not'; expr: Expr; pos: Pos }
  | { kind: 'and' | 'or'; left: Expr; right: Expr; pos: Pos }
  | { kind: 'cmp'; op: '=' | '<>' | '<' | '<=' | '>' | '>='; left: Expr; right: Expr; pos: Pos }
  | { kind: 'in'; needle: Expr; haystack: Expr; pos: Pos }
  | { kind: 'text'; op: 'contains' | 'startsWith' | 'endsWith'; left: Expr; right: Expr; pos: Pos }
  | { kind: 'exists'; target: string; property: string; pos: Pos }
  | { kind: 'list'; items: Expr[]; pos: Pos }
  | { kind: 'call'; func: string; arg: Expr | '*'; distinct: boolean; pos: Pos };

export const AGGREGATES = new Set(['count', 'collect', 'sum', 'avg', 'min', 'max']);
export const SCALAR_FUNCS = new Set(['id', 'labels', 'type']);

export interface NodePattern {
  variable?: string;
  labels: string[];
  props: { property: string; value: Expr }[];
  pos: Pos;
}

export interface EdgePattern {
  variable?: string;
  types: string[];
  direction: 'out' | 'in' | 'both';
  varLength?: { min: number; max: number };
  pos: Pos;
}

export interface PathPattern {
  nodes: NodePattern[];
  edges: EdgePattern[]; // nodes.length === edges.length + 1
}

export interface ReturnItem {
  expr: Expr;
  alias?: string;
  pos: Pos;
}

export interface ReadQuery {
  patterns: PathPattern[];
  where?: Expr;
  distinct: boolean;
  items: ReturnItem[];
  orderBy: { expr: Expr; desc: boolean }[];
  skip?: Expr; // number literal or param (parser-enforced)
  limit?: Expr;
}

export interface ParsedQuery {
  explain: boolean;
  query: ReadQuery;
}

export const MAX_VAR_HOPS_DEFAULT = 8;
export const MAX_VAR_HOPS = 15;

/** Depth-first walk over an expression tree. */
export function walkExpr(e: Expr, visit: (e: Expr) => void): void {
  visit(e);
  switch (e.kind) {
    case 'not':
      walkExpr(e.expr, visit);
      return;
    case 'and':
    case 'or':
      walkExpr(e.left, visit);
      walkExpr(e.right, visit);
      return;
    case 'cmp':
    case 'text':
      walkExpr(e.left, visit);
      walkExpr(e.right, visit);
      return;
    case 'in':
      walkExpr(e.needle, visit);
      walkExpr(e.haystack, visit);
      return;
    case 'list':
      for (const item of e.items) walkExpr(item, visit);
      return;
    case 'call':
      if (e.arg !== '*') walkExpr(e.arg, visit);
      return;
    default:
      return;
  }
}
```

- [ ] **Step 2: Write the failing tests**

`packages/query/test/expr-parser.test.ts`:

```ts
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
    expect(parse('EXISTS(p.born)')).toMatchObject({ kind: 'exists', target: 'p', property: 'born' });
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run packages/query/test/expr-parser.test.ts`
Expected: FAIL — `parser.js` not found.

- [ ] **Step 4: Implement**

`packages/query/src/parser.ts`:

```ts
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run packages/query/test/expr-parser.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(query): AQL AST and precedence-climbing expression parser"
```

### Task 4: Pattern + query parser with semantic validation

**Files:**
- Modify: `packages/query/src/parser.ts` (append the query grammar + validation)
- Test: `packages/query/test/parser.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/query/test/parser.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AqlError } from '../src/errors.js';
import { parseQuery } from '../src/parser.js';

describe('parseQuery — patterns', () => {
  it('parses the spec example end to end', () => {
    const { explain, query } = parseQuery(
      "MATCH (p:Person)-[:WROTE]->(d:Document)\nWHERE d.year > 1840 AND p.name CONTAINS 'lovelace'\nRETURN p.name, count(d) AS works\nORDER BY works DESC LIMIT 10",
    );
    expect(explain).toBe(false);
    expect(query.patterns).toHaveLength(1);
    const pat = query.patterns[0]!;
    expect(pat.nodes.map((n) => n.labels[0])).toEqual(['Person', 'Document']);
    expect(pat.edges[0]).toMatchObject({ types: ['WROTE'], direction: 'out' });
    expect(query.where?.kind).toBe('and');
    expect(query.items).toHaveLength(2);
    expect(query.items[1]).toMatchObject({ alias: 'works' });
    expect(query.orderBy[0]).toMatchObject({ desc: true });
    expect(query.limit).toMatchObject({ kind: 'literal', value: 10 });
  });

  it('parses directions, multi-types, inline props, and anonymous elements', () => {
    const { query } = parseQuery(
      'MATCH (a {name: $n})<-[:CITES|MENTIONS]-(b), (b)-[e]-(c:Doc:Old) RETURN a',
    );
    const [p1, p2] = query.patterns;
    expect(p1!.edges[0]).toMatchObject({ types: ['CITES', 'MENTIONS'], direction: 'in' });
    expect(p1!.nodes[0]!.props[0]).toMatchObject({ property: 'name' });
    expect(p2!.edges[0]).toMatchObject({ direction: 'both', variable: 'e', types: [] });
    expect(p2!.nodes[1]!.labels).toEqual(['Doc', 'Old']);
  });

  it('parses variable-length forms with defaults and caps', () => {
    const q = (src: string) => parseQuery(src).query.patterns[0]!.edges[0]!.varLength;
    expect(q('MATCH (a)-[:R*]->(b) RETURN a')).toEqual({ min: 1, max: 8 });
    expect(q('MATCH (a)-[:R*3]->(b) RETURN a')).toEqual({ min: 3, max: 3 });
    expect(q('MATCH (a)-[:R*1..3]->(b) RETURN a')).toEqual({ min: 1, max: 3 });
    expect(() => parseQuery('MATCH (a)-[:R*1..20]->(b) RETURN a')).toThrowError(AqlError);
  });

  it('parses EXPLAIN prefix and DISTINCT/SKIP', () => {
    const { explain, query } = parseQuery('EXPLAIN MATCH (n) RETURN DISTINCT n SKIP $s LIMIT 5');
    expect(explain).toBe(true);
    expect(query.distinct).toBe(true);
    expect(query.skip).toMatchObject({ kind: 'param', name: 's' });
  });
});

describe('parseQuery — semantic validation', () => {
  const err = (src: string): AqlError => {
    try {
      parseQuery(src);
    } catch (e) {
      return e as AqlError;
    }
    throw new Error('expected parseQuery to throw');
  };

  it('rejects unknown variables with position', () => {
    const e = err('MATCH (p:Person) RETURN q.name');
    expect(e.code).toBe('SEMANTIC_ERROR');
    expect(e.message).toContain('q');
    expect(e.snippet).toContain('^');
  });

  it('rejects aggregates in WHERE and unknown functions', () => {
    expect(err('MATCH (p) WHERE count(p) > 1 RETURN p').code).toBe('SEMANTIC_ERROR');
    expect(err('MATCH (p) RETURN frobnicate(p)').code).toBe('SEMANTIC_ERROR');
  });

  it('rejects a variable bound as both node and edge', () => {
    expect(err('MATCH (x)-[x]->(y) RETURN x').code).toBe('SEMANTIC_ERROR');
  });

  it('rejects variables on variable-length edges (v1)', () => {
    expect(err('MATCH (a)-[e:R*1..2]->(b) RETURN a').code).toBe('SEMANTIC_ERROR');
  });

  it('rejects writes (M4b scope) as parse errors', () => {
    expect(err("CREATE (n:X) RETURN n").code).toBe('PARSE_ERROR');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/query/test/parser.test.ts`
Expected: FAIL — `parseQuery` is not exported.

- [ ] **Step 3: Append the query grammar to `packages/query/src/parser.ts`**

```ts
import {
  MAX_VAR_HOPS,
  MAX_VAR_HOPS_DEFAULT,
  walkExpr,
  type EdgePattern,
  type NodePattern,
  type ParsedQuery,
  type PathPattern,
  type ReadQuery,
  type ReturnItem,
} from './ast.js';
import { lex } from './lexer.js';
```

(Merge these into the existing import block from `./ast.js` — keep one import statement per module.)

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/query/test/parser.test.ts packages/query/test/expr-parser.test.ts`
Expected: PASS — including the writes-rejected case (`CREATE` is not a keyword, so the parser fails expecting `MATCH`; M4b adds it).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(query): pattern and read-query parser with semantic validation"
```

### Task 5: Expression evaluator

Null semantics (v1, simpler than Cypher 3VL, documented): any comparison/text/IN with a `null`/missing operand is `false`; `NOT x` is `!(x === true)`; `AND`/`OR` operate on truthiness (`=== true`). Equality is type-strict (`1 = '1'` is false), Dates compare by epoch, records by identity (kind+id), arrays deep-equal.

**Files:**
- Create: `packages/query/src/eval.ts`
- Test: `packages/query/test/eval.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/query/test/eval.test.ts`:

```ts
import type { NodeRecord } from '@atlas/core';
import { describe, expect, it } from 'vitest';
import { AqlError } from '../src/errors.js';
import { evalExpr, type Binding } from '../src/eval.js';
import { lex } from '../src/lexer.js';
import { TokenStream, parseExpression } from '../src/parser.js';

const ada: NodeRecord = { id: 1, labels: ['Person'], props: { name: 'Ada', born: 1815, tags: ['math'] } };
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/query/test/eval.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/query/src/eval.ts`:

```ts
import type { EdgeRecord, NodeRecord } from '@atlas/core';
import { AGGREGATES, type Expr } from './ast.js';
import { AqlError } from './errors.js';

export type RuntimeValue =
  | string
  | number
  | boolean
  | Date
  | null
  | RuntimeValue[]
  | NodeRecord
  | EdgeRecord;

export type Binding = Map<string, NodeRecord | EdgeRecord>;

export interface EvalContext {
  params: Record<string, unknown>;
  source: string;
}

function isRecord(v: RuntimeValue): v is NodeRecord | EdgeRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && 'id' in v;
}

/** Type-strict equality; null never equals anything (including null). */
export function valuesEqual(a: RuntimeValue, b: RuntimeValue): boolean {
  if (a === null || b === null) return false;
  if (a instanceof Date || b instanceof Date)
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => valuesEqual(x, b[i]!));
  }
  if (isRecord(a) || isRecord(b)) {
    if (!isRecord(a) || !isRecord(b)) return false;
    const aKind = 'type' in a ? 'edge' : 'node';
    const bKind = 'type' in b ? 'edge' : 'node';
    return aKind === bKind && a.id === b.id;
  }
  return typeof a === typeof b && a === b;
}

/** Ordering for < <= > >=: same-type scalars only; null/mixed -> null (incomparable). */
export function compareRuntime(a: RuntimeValue, b: RuntimeValue): number | null {
  if (a === null || b === null) return null;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  return null;
}

export function evalExpr(e: Expr, binding: Binding, ctx: EvalContext): RuntimeValue {
  switch (e.kind) {
    case 'literal':
      return e.value;
    case 'param': {
      if (!(e.name in ctx.params))
        throw new AqlError('RUNTIME_ERROR', `missing parameter $${e.name}`, e.pos, ctx.source);
      return ctx.params[e.name] as RuntimeValue;
    }
    case 'variable':
      return binding.get(e.name) ?? null;
    case 'prop': {
      const rec = binding.get(e.target);
      if (!rec) return null;
      return (rec.props[e.property] as RuntimeValue) ?? null;
    }
    case 'exists': {
      const rec = binding.get(e.target);
      return rec !== undefined && e.property in rec.props;
    }
    case 'not':
      return evalExpr(e.expr, binding, ctx) !== true;
    case 'and':
      return evalExpr(e.left, binding, ctx) === true && evalExpr(e.right, binding, ctx) === true;
    case 'or':
      return evalExpr(e.left, binding, ctx) === true || evalExpr(e.right, binding, ctx) === true;
    case 'cmp': {
      const a = evalExpr(e.left, binding, ctx);
      const b = evalExpr(e.right, binding, ctx);
      if (e.op === '=') return valuesEqual(a, b);
      if (e.op === '<>') return a !== null && b !== null && !valuesEqual(a, b);
      const c = compareRuntime(a, b);
      if (c === null) return false;
      if (e.op === '<') return c < 0;
      if (e.op === '<=') return c <= 0;
      if (e.op === '>') return c > 0;
      return c >= 0;
    }
    case 'text': {
      const a = evalExpr(e.left, binding, ctx);
      const b = evalExpr(e.right, binding, ctx);
      if (typeof a !== 'string' || typeof b !== 'string') return false;
      if (e.op === 'contains') return a.includes(b);
      if (e.op === 'startsWith') return a.startsWith(b);
      return a.endsWith(b);
    }
    case 'in': {
      const needle = evalExpr(e.needle, binding, ctx);
      const haystack = evalExpr(e.haystack, binding, ctx);
      if (!Array.isArray(haystack)) return false;
      return haystack.some((item) => valuesEqual(needle, item));
    }
    case 'list':
      return e.items.map((item) => evalExpr(item, binding, ctx));
    case 'call': {
      if (AGGREGATES.has(e.func))
        throw new AqlError(
          'RUNTIME_ERROR',
          `aggregate ${e.func}() must be handled by the executor`,
          e.pos,
          ctx.source,
        );
      const arg = e.arg === '*' ? null : evalExpr(e.arg, binding, ctx);
      if (arg === null || !isRecord(arg))
        throw new AqlError('RUNTIME_ERROR', `${e.func}() expects a bound variable`, e.pos, ctx.source);
      if (e.func === 'id') return arg.id;
      if (e.func === 'labels') {
        if (!('labels' in arg))
          throw new AqlError('RUNTIME_ERROR', 'labels() expects a node', e.pos, ctx.source);
        return [...arg.labels];
      }
      // type(r)
      if (!('type' in arg))
        throw new AqlError('RUNTIME_ERROR', 'type() expects an edge', e.pos, ctx.source);
      return arg.type;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/query/test/eval.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(query): expression evaluator with strict null semantics"
```

### Task 6: Plan types, planner, EXPLAIN serialization

The planner picks each pattern's cheapest starting point — `IndexSeek` (cost 1) when a node has an equality on an indexed `(label, property)` (from inline props or top-level `AND` conjuncts of WHERE), else `LabelScan` (cost = labelCount, cheapest label), else `AllNodesScan` (cost = node count) — then expands outward. Plan nodes carry both display strings (serialized by EXPLAIN) and `...Ast` fields (used by the executor, stripped from EXPLAIN output).

**Files:**
- Create: `packages/query/src/plan.ts`, `packages/query/src/planner.ts`
- Test: `packages/query/test/planner.test.ts`

- [ ] **Step 1: Write the plan-type module**

`packages/query/src/plan.ts`:

```ts
import type { Expr } from './ast.js';

export type PlanNode =
  | { op: 'AllNodesScan'; variable: string; estCost: number }
  | { op: 'LabelScan'; variable: string; label: string; estCost: number }
  | {
      op: 'IndexSeek';
      variable: string;
      label: string;
      property: string;
      value: string;
      valueAst: Expr;
      estCost: number;
    }
  | { op: 'FromBound'; variable: string }
  | {
      op: 'Expand';
      from: string;
      to: string;
      edgeVariable?: string;
      types: string[];
      direction: 'out' | 'in' | 'both';
      toLabels: string[];
      child: PlanNode;
    }
  | {
      op: 'VarLengthExpand';
      from: string;
      to: string;
      types: string[];
      direction: 'out' | 'in' | 'both';
      min: number;
      max: number;
      toLabels: string[];
      child: PlanNode;
    }
  | { op: 'Filter'; expr: string; exprAst: Expr; child: PlanNode }
  | { op: 'CartesianProduct'; left: PlanNode; right: PlanNode }
  | {
      op: 'Aggregate';
      groupBy: string[];
      aggregates: string[];
      child: PlanNode;
    }
  | { op: 'Project'; columns: string[]; child: PlanNode }
  | { op: 'Distinct'; child: PlanNode }
  | { op: 'Sort'; keys: string[]; child: PlanNode }
  | { op: 'SkipLimit'; skip?: number | string; limit?: number | string; child: PlanNode };

/** Compact display form of an expression for EXPLAIN output. */
export function renderExpr(e: Expr): string {
  switch (e.kind) {
    case 'literal':
      return typeof e.value === 'string' ? `'${e.value}'` : String(e.value);
    case 'param':
      return `$${e.name}`;
    case 'variable':
      return e.name;
    case 'prop':
      return `${e.target}.${e.property}`;
    case 'not':
      return `NOT ${renderExpr(e.expr)}`;
    case 'and':
      return `(${renderExpr(e.left)} AND ${renderExpr(e.right)})`;
    case 'or':
      return `(${renderExpr(e.left)} OR ${renderExpr(e.right)})`;
    case 'cmp':
      return `${renderExpr(e.left)} ${e.op} ${renderExpr(e.right)}`;
    case 'text': {
      const op = e.op === 'contains' ? 'CONTAINS' : e.op === 'startsWith' ? 'STARTS WITH' : 'ENDS WITH';
      return `${renderExpr(e.left)} ${op} ${renderExpr(e.right)}`;
    }
    case 'in':
      return `${renderExpr(e.needle)} IN ${renderExpr(e.haystack)}`;
    case 'exists':
      return `EXISTS(${e.target}.${e.property})`;
    case 'list':
      return `[${e.items.map(renderExpr).join(', ')}]`;
    case 'call':
      return `${e.func}(${e.distinct ? 'DISTINCT ' : ''}${e.arg === '*' ? '*' : renderExpr(e.arg)})`;
  }
}

/** EXPLAIN payload: the plan tree as plain JSON, with executor-only `...Ast` fields stripped. */
export function serializePlan(node: PlanNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key.endsWith('Ast')) continue;
    if (value !== null && typeof value === 'object' && 'op' in (value as object))
      out[key] = serializePlan(value as PlanNode);
    else out[key] = value;
  }
  return out;
}
```

- [ ] **Step 2: Write the failing tests**

`packages/query/test/planner.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '@atlas/core';
import { parseQuery } from '../src/parser.js';
import { planQuery } from '../src/planner.js';
import { serializePlan, type PlanNode } from '../src/plan.js';

let dir: string;
let db: AtlasDatabase;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-planner-'));
  db = await openDatabase(dir);
  await db.transact((tx) => {
    tx.createIndex({ kind: 'property', label: 'Person', property: 'born' });
    for (let i = 0; i < 20; i++) tx.createNode(['Person'], { born: 1800 + i });
    for (let i = 0; i < 3; i++) tx.createNode(['Document'], { year: 1840 + i });
  });
});
afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

function plan(src: string): PlanNode {
  return planQuery(parseQuery(src).query, db.graphStore);
}

function leftmost(p: PlanNode): PlanNode {
  let n = p;
  for (;;) {
    if ('child' in n && n.child) n = n.child;
    else if (n.op === 'CartesianProduct') n = n.left;
    else return n;
  }
}

describe('planner start selection', () => {
  it('picks IndexSeek for an indexed inline equality', () => {
    expect(leftmost(plan('MATCH (p:Person {born: 1815}) RETURN p'))).toMatchObject({
      op: 'IndexSeek',
      label: 'Person',
      property: 'born',
      estCost: 1,
    });
  });

  it('extracts indexed equalities from top-level WHERE conjuncts', () => {
    expect(leftmost(plan('MATCH (p:Person) WHERE p.born = $b AND p.name = $n RETURN p'))).toMatchObject(
      { op: 'IndexSeek', property: 'born' },
    );
  });

  it('falls back to the cheapest LabelScan, then AllNodesScan', () => {
    expect(leftmost(plan('MATCH (d:Document) RETURN d'))).toMatchObject({
      op: 'LabelScan',
      label: 'Document',
      estCost: 3,
    });
    expect(leftmost(plan('MATCH (x) RETURN x'))).toMatchObject({ op: 'AllNodesScan', estCost: 23 });
  });

  it('starts the cheaper end of a path pattern', () => {
    // Document (3 nodes) is cheaper than Person (20) — expansion must flip to "in".
    const p = plan('MATCH (p:Person)-[:WROTE]->(d:Document) RETURN p');
    expect(leftmost(p)).toMatchObject({ op: 'LabelScan', label: 'Document' });
    const expand = JSON.stringify(serializePlan(p));
    expect(expand).toContain('"direction":"in"');
  });

  it('second pattern sharing a variable splices into the stream; disjoint patterns go cartesian', () => {
    // The FromBound leaf is spliced away during joining — the tell is NO cartesian product.
    const shared = plan('MATCH (p:Person)-[:KNOWS]->(q:Person), (q)-[:WROTE]->(d) RETURN d');
    expect(JSON.stringify(serializePlan(shared))).not.toContain('"op":"CartesianProduct"');
    expect(JSON.stringify(serializePlan(shared))).not.toContain('"op":"FromBound"');
    const disjoint = plan('MATCH (a:Person), (b:Document) RETURN a, b');
    expect(JSON.stringify(serializePlan(disjoint))).toContain('"op":"CartesianProduct"');
  });

  it('EXPLAIN serialization strips Ast fields and is JSON-round-trippable', () => {
    const p = plan("MATCH (p:Person {born: 1815})-[:WROTE*1..2]->(d) WHERE d.year > 1 RETURN p, d LIMIT 5");
    const json = serializePlan(p);
    const text = JSON.stringify(json);
    expect(text).not.toContain('Ast');
    expect(text).toContain('"op":"VarLengthExpand"');
    expect(text).toContain('"op":"SkipLimit"');
    expect(JSON.parse(text)).toEqual(json);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run packages/query/test/planner.test.ts`
Expected: FAIL — `planner.js` not found.

- [ ] **Step 4: Implement**

`packages/query/src/planner.ts`:

```ts
import type { GraphStore } from '@atlas/core';
import { AGGREGATES, walkExpr, type Expr, type PathPattern, type ReadQuery } from './ast.js';
import { renderExpr, type PlanNode } from './plan.js';

interface SeekCandidate {
  property: string;
  value: Expr;
}

/** var.prop = literal/param equalities from inline props plus top-level AND conjuncts of WHERE. */
function equalitiesFor(
  pattern: PathPattern,
  nodeIdx: number,
  where: Expr | undefined,
): SeekCandidate[] {
  const node = pattern.nodes[nodeIdx]!;
  const out: SeekCandidate[] = node.props.map((p) => ({ property: p.property, value: p.value }));
  if (node.variable !== undefined && where) {
    const conjuncts: Expr[] = [];
    const flatten = (e: Expr): void => {
      if (e.kind === 'and') {
        flatten(e.left);
        flatten(e.right);
      } else {
        conjuncts.push(e);
      }
    };
    flatten(where);
    for (const c of conjuncts) {
      if (
        c.kind === 'cmp' &&
        c.op === '=' &&
        c.left.kind === 'prop' &&
        c.left.target === node.variable &&
        (c.right.kind === 'literal' || c.right.kind === 'param')
      )
        out.push({ property: c.left.property, value: c.right });
    }
  }
  return out;
}

function hasScalarIndex(store: GraphStore, label: string, property: string): boolean {
  return (
    store.indexes.has({ kind: 'property', label, property }) ||
    store.indexes.has({ kind: 'unique', label, property })
  );
}

interface StartChoice {
  nodeIdx: number;
  scan: PlanNode;
  consumedLabel?: string;
  consumedProperty?: string;
}

let anonCounter = 0;

/** Stable synthetic variable for anonymous pattern elements (per-plan counter). */
function varName(explicit: string | undefined, role: string): string {
  return explicit ?? `__${role}${anonCounter++}`;
}

function chooseStart(
  pattern: PathPattern,
  where: Expr | undefined,
  store: GraphStore,
  bound: Set<string>,
): StartChoice {
  let best: StartChoice | undefined;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let i = 0; i < pattern.nodes.length; i++) {
    const node = pattern.nodes[i]!;
    if (node.variable !== undefined && bound.has(node.variable)) {
      return { nodeIdx: i, scan: { op: 'FromBound', variable: node.variable } };
    }
    let choice: StartChoice | undefined;
    let cost = store.nodes.size;
    for (const label of node.labels) {
      for (const eq of equalitiesFor(pattern, i, where)) {
        if (hasScalarIndex(store, label, eq.property)) {
          choice = {
            nodeIdx: i,
            scan: {
              op: 'IndexSeek',
              variable: varName(node.variable, 'n'),
              label,
              property: eq.property,
              value: renderExpr(eq.value),
              valueAst: eq.value,
              estCost: 1,
            },
            consumedLabel: label,
            consumedProperty: eq.property,
          };
          cost = 1;
          break;
        }
      }
      if (choice) break;
    }
    if (!choice && node.labels.length > 0) {
      let cheapest = node.labels[0]!;
      for (const label of node.labels)
        if (store.labelCount(label) < store.labelCount(cheapest)) cheapest = label;
      cost = store.labelCount(cheapest);
      choice = {
        nodeIdx: i,
        scan: { op: 'LabelScan', variable: varName(node.variable, 'n'), label: cheapest, estCost: cost },
        consumedLabel: cheapest,
      };
    }
    if (!choice) {
      choice = {
        nodeIdx: i,
        scan: { op: 'AllNodesScan', variable: varName(node.variable, 'n'), estCost: cost },
      };
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = choice;
    }
  }
  return best!;
}

const FLIP = { out: 'in', in: 'out', both: 'both' } as const;

export function planQuery(query: ReadQuery, store: GraphStore): PlanNode {
  anonCounter = 0;
  const bound = new Set<string>();
  const varOf = new Map<object, string>(); // pattern element -> assigned variable
  let root: PlanNode | undefined;

  for (const pattern of query.patterns) {
    const start = chooseStart(pattern, query.where, store, bound);
    // Assign variables to every element up front so expands agree on names.
    const nodeVars = pattern.nodes.map((n) => varName(n.variable, 'n'));
    const startNode = pattern.nodes[start.nodeIdx]!;
    if (start.scan.op !== 'FromBound') {
      nodeVars[start.nodeIdx] = (start.scan as { variable: string }).variable;
    } else {
      nodeVars[start.nodeIdx] = startNode.variable!;
    }
    let chain: PlanNode = start.scan;
    // Residual start-node checks not consumed by the scan:
    const residLabels = startNode.labels.filter((l) => l !== start.consumedLabel);
    if (start.scan.op !== 'FromBound' && residLabels.length === 0 && startNode.labels.length === 0) {
      // AllNodesScan with no labels: nothing to check
    }
    chain = withNodeChecks(chain, nodeVars[start.nodeIdx]!, residLabels, startNode, start.consumedProperty);
    // Expand left (toward index 0) then right (toward the end).
    for (let i = start.nodeIdx - 1; i >= 0; i--) {
      const edge = pattern.edges[i]!;
      chain = expandStep(chain, nodeVars[i + 1]!, nodeVars[i]!, edge, FLIP[edge.direction], pattern.nodes[i]!);
    }
    for (let i = start.nodeIdx; i < pattern.edges.length; i++) {
      const edge = pattern.edges[i]!;
      chain = expandStep(chain, nodeVars[i]!, nodeVars[i + 1]!, edge, edge.direction, pattern.nodes[i + 1]!);
    }
    for (const [i, n] of pattern.nodes.entries()) {
      if (n.variable !== undefined) bound.add(n.variable);
      varOf.set(n, nodeVars[i]!);
    }
    for (const e of pattern.edges) if (e.variable !== undefined) bound.add(e.variable);
    root = root === undefined ? chain : joinPlans(root, chain);
  }

  let plan = root!;
  if (query.where)
    plan = { op: 'Filter', expr: renderExpr(query.where), exprAst: query.where, child: plan };

  const hasAggregate = query.items.some((item) => {
    let agg = false;
    walkExpr(item.expr, (e) => {
      if (e.kind === 'call' && AGGREGATES.has(e.func)) agg = true;
    });
    return agg;
  });
  const columns = query.items.map((item, i) => item.alias ?? renderExpr(item.expr) ?? `col${i}`);
  if (hasAggregate) {
    plan = {
      op: 'Aggregate',
      groupBy: query.items.filter((it) => !isAggregateItem(it.expr)).map((it) => it.alias ?? renderExpr(it.expr)),
      aggregates: query.items.filter((it) => isAggregateItem(it.expr)).map((it) => renderExpr(it.expr)),
      child: plan,
    };
  } else {
    plan = { op: 'Project', columns, child: plan };
  }
  if (query.distinct) plan = { op: 'Distinct', child: plan };
  if (query.orderBy.length > 0)
    plan = { op: 'Sort', keys: query.orderBy.map((o) => `${renderExpr(o.expr)}${o.desc ? ' DESC' : ''}`), child: plan };
  if (query.skip !== undefined || query.limit !== undefined)
    plan = {
      op: 'SkipLimit',
      skip: query.skip ? renderCount(query.skip) : undefined,
      limit: query.limit ? renderCount(query.limit) : undefined,
      child: plan,
    };
  return plan;
}

export function isAggregateItem(e: Expr): boolean {
  let agg = false;
  walkExpr(e, (x) => {
    if (x.kind === 'call' && AGGREGATES.has(x.func)) agg = true;
  });
  return agg;
}

function renderCount(e: Expr): number | string {
  return e.kind === 'literal' ? (e.value as number) : `$${(e as { name: string }).name}`;
}

function expandStep(
  child: PlanNode,
  from: string,
  to: string,
  edge: { variable?: string; types: string[]; varLength?: { min: number; max: number } },
  direction: 'out' | 'in' | 'both',
  toNode: { labels: string[]; props: { property: string; value: Expr }[]; variable?: string; pos: { line: number; column: number } },
): PlanNode {
  const base: PlanNode = edge.varLength
    ? {
        op: 'VarLengthExpand',
        from,
        to,
        types: edge.types,
        direction,
        min: edge.varLength.min,
        max: edge.varLength.max,
        toLabels: toNode.labels,
        child,
      }
    : {
        op: 'Expand',
        from,
        to,
        edgeVariable: edge.variable,
        types: edge.types,
        direction,
        toLabels: toNode.labels,
        child,
      };
  return withNodeChecks(base, to, [], toNode, undefined);
}

/** Inline property equalities (and residual labels for starts) become Filter nodes. */
function withNodeChecks(
  child: PlanNode,
  variable: string,
  residualLabels: string[],
  node: { props: { property: string; value: Expr }[]; pos: { line: number; column: number } },
  consumedProperty: string | undefined,
): PlanNode {
  let plan = child;
  for (const label of residualLabels) {
    const expr: Expr = {
      kind: 'in',
      needle: { kind: 'literal', value: label, pos: node.pos },
      haystack: { kind: 'call', func: 'labels', arg: { kind: 'variable', name: variable, pos: node.pos }, distinct: false, pos: node.pos },
      pos: node.pos,
    };
    plan = { op: 'Filter', expr: renderExpr(expr), exprAst: expr, child: plan };
  }
  for (const p of node.props) {
    if (p.property === consumedProperty) continue;
    const expr: Expr = {
      kind: 'cmp',
      op: '=',
      left: { kind: 'prop', target: variable, property: p.property, pos: node.pos },
      right: p.value,
      pos: node.pos,
    };
    plan = { op: 'Filter', expr: renderExpr(expr), exprAst: expr, child: plan };
  }
  return plan;
}

function joinPlans(left: PlanNode, right: PlanNode): PlanNode {
  // If the right chain starts FromBound it continues the left stream directly.
  let leaf: PlanNode = right;
  while ('child' in leaf && leaf.child) leaf = leaf.child;
  if (leaf.op === 'FromBound') {
    // splice: replace the FromBound leaf's position by chaining right on top of left
    return spliceChild(right, left, leaf);
  }
  return { op: 'CartesianProduct', left, right };
}

function spliceChild(tree: PlanNode, replacement: PlanNode, leaf: PlanNode): PlanNode {
  if (tree === leaf) return replacement;
  if ('child' in tree && tree.child)
    return { ...tree, child: spliceChild(tree.child, replacement, leaf) } as PlanNode;
  return tree;
}
```

Note for the implementer: `Expand`'s `toLabels` are checked by the **executor** for expanded targets (Task 7); the planner only emits `Filter` nodes for inline **props** of non-start nodes and residual checks of the start node — that keeps label checks O(1) inside the expand loop instead of building synthetic exprs per hop. The synthetic-`Filter` path via `withNodeChecks(..., residualLabels, ...)` is used only for the start node's residual labels.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run packages/query/test/planner.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(query): selectivity-based planner with EXPLAIN-serializable plans"
```

### Task 7: Executor

One module: a lazy `bindings()` generator walks the plan's pattern subtree (scans → expands → filters → joins), then a result stage projects/aggregates/sorts. Guards: `bump()` per binding examined (clock checked every 1024), `result()` per emitted row (`ROW_LIMIT` beyond `maxRows` — an error, never silent truncation). Result rows contain **live** `NodeRecord`/`EdgeRecord` references — callers must not mutate (same convention as core reads).

**Files:**
- Create: `packages/query/src/exec.ts`
- Test: `packages/query/test/exec-basic.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/query/test/exec-basic.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase, type NodeRecord } from '@atlas/core';
import { AqlError } from '../src/errors.js';
import { runRead } from '../src/exec.js';
import { parseQuery } from '../src/parser.js';
import { planQuery } from '../src/planner.js';

let dir: string;
let db: AtlasDatabase;
let ids: Record<string, number>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-execb-'));
  db = await openDatabase(dir);
  ids = {};
  await db.transact((tx) => {
    tx.createIndex({ kind: 'property', label: 'Person', property: 'born' });
    ids.ada = tx.createNode(['Person'], { name: 'Ada', born: 1815 });
    ids.charles = tx.createNode(['Person'], { name: 'Charles', born: 1791 });
    ids.marie = tx.createNode(['Person'], { name: 'Marie', born: 1867 });
    ids.notes = tx.createNode(['Document'], { title: 'Notes', year: 1843 });
    ids.sketch = tx.createNode(['Document'], { title: 'Sketch', year: 1842 });
    tx.createEdge('WROTE', ids.ada, ids.notes);
    tx.createEdge('WROTE', ids.charles, ids.sketch);
    tx.createEdge('KNOWS', ids.ada, ids.charles);
  });
});
afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

function run(src: string, params: Record<string, unknown> = {}, opts: { maxRows?: number; timeoutMs?: number } = {}) {
  const { query } = parseQuery(src);
  const plan = planQuery(query, db.graphStore);
  return runRead(plan, query, db.graphStore, {
    params,
    source: src,
    timeoutMs: opts.timeoutMs ?? 10_000,
    maxRows: opts.maxRows ?? 100_000,
  });
}

describe('runRead — basics', () => {
  it('label scan + projection of props and whole nodes', () => {
    const r = run('MATCH (p:Person) RETURN p.name AS name, p ORDER BY name');
    expect(r.columns).toEqual(['name', 'p']);
    expect(r.rows.map((row) => row[0])).toEqual(['Ada', 'Charles', 'Marie']);
    expect((r.rows[0]![1] as NodeRecord).id).toBe(ids.ada);
  });

  it('index seek start with WHERE residual', () => {
    const r = run('MATCH (p:Person {born: 1815}) RETURN p.name');
    expect(r.rows).toEqual([['Ada']]);
    expect(r.stats.rowsExamined).toBeLessThan(4); // seek, not scan
  });

  it('expand with type and direction, inline target props as filters', () => {
    expect(run('MATCH (p:Person)-[:WROTE]->(d:Document {year: 1843}) RETURN p.name').rows).toEqual([
      ['Ada'],
    ]);
    expect(run('MATCH (d:Document)<-[:WROTE]-(p) RETURN d.title ORDER BY d.title').rows).toEqual([
      ['Notes'],
      ['Sketch'],
    ]);
    expect(run('MATCH (a:Person)-[:KNOWS]-(b:Person) RETURN a.name ORDER BY a.name').rows).toEqual([
      ['Ada'],
      ['Charles'],
    ]); // both-direction matches each endpoint once
  });

  it('edge variables bind and project', () => {
    const r = run('MATCH (p)-[w:WROTE]->(d) RETURN type(w), d.title ORDER BY d.title');
    expect(r.rows.map((row) => row[0])).toEqual(['WROTE', 'WROTE']);
  });

  it('WHERE with params; missing label/prop yields empty', () => {
    expect(run('MATCH (p:Person) WHERE p.born > $y RETURN p.name', { y: 1800 }).rows).toHaveLength(2);
    expect(run('MATCH (p:Ghost) RETURN p').rows).toEqual([]);
  });

  it('ORDER BY DESC, SKIP, LIMIT with params', () => {
    const r = run('MATCH (p:Person) RETURN p.born ORDER BY p.born DESC SKIP 1 LIMIT $n', { n: 1 });
    expect(r.rows).toEqual([[1815]]);
  });

  it('DISTINCT collapses duplicate rows', () => {
    const r = run('MATCH (p:Person)-[:WROTE|KNOWS]->(x) RETURN DISTINCT p.name ORDER BY p.name');
    expect(r.rows).toEqual([['Ada'], ['Charles']]);
  });

  it('ROW_LIMIT and TIMEOUT guards fire as errors, never truncation', () => {
    expect(() => run('MATCH (p:Person) RETURN p', {}, { maxRows: 2 })).toThrowError(AqlError);
    try {
      run('MATCH (a)-[*1..8]-(b) RETURN count(*)', {}, { timeoutMs: 0 });
      expect.unreachable();
    } catch (e) {
      expect(['TIMEOUT', 'ROW_LIMIT']).toContain((e as AqlError).code);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/query/test/exec-basic.test.ts`
Expected: FAIL — `exec.js` not found.

- [ ] **Step 3: Implement**

`packages/query/src/exec.ts`:

```ts
import type { EdgeRecord, GraphStore, NodeRecord } from '@atlas/core';
import { type Expr, type ReadQuery } from './ast.js';
import { AqlError } from './errors.js';
import {
  compareRuntime,
  evalExpr,
  valuesEqual,
  type Binding,
  type EvalContext,
  type RuntimeValue,
} from './eval.js';
import { renderExpr, type PlanNode } from './plan.js';
import { isAggregateItem } from './planner.js';

export interface ExecOptions {
  params: Record<string, unknown>;
  source: string;
  timeoutMs: number;
  maxRows: number;
}

export interface ReadResult {
  columns: string[];
  rows: RuntimeValue[][];
  stats: { rowsExamined: number };
}

const ORIGIN = { line: 1, column: 1 };
const CLOCK_EVERY = 1024;

class Guard {
  rowsExamined = 0;
  private produced = 0;
  private readonly deadline: number;

  constructor(private readonly opts: ExecOptions) {
    this.deadline = Date.now() + opts.timeoutMs;
  }

  bump(): void {
    this.rowsExamined++;
    if (this.rowsExamined % CLOCK_EVERY === 0 && Date.now() > this.deadline) this.timeout();
    // timeoutMs of 0 must fire deterministically even on tiny graphs:
    if (this.opts.timeoutMs <= 0) this.timeout();
  }

  result(): void {
    if (++this.produced > this.opts.maxRows)
      throw new AqlError(
        'ROW_LIMIT',
        `query produced more than maxRows=${this.opts.maxRows} rows`,
        ORIGIN,
        this.opts.source,
      );
  }

  private timeout(): never {
    throw new AqlError('TIMEOUT', `query exceeded ${this.opts.timeoutMs} ms`, ORIGIN, this.opts.source);
  }
}

function isBindingOp(node: PlanNode): boolean {
  return ['AllNodesScan', 'LabelScan', 'IndexSeek', 'FromBound', 'Expand', 'VarLengthExpand', 'Filter', 'CartesianProduct'].includes(node.op);
}

function hasAllLabels(n: NodeRecord, labels: string[]): boolean {
  return labels.every((l) => n.labels.includes(l));
}

export function runRead(plan: PlanNode, query: ReadQuery, store: GraphStore, opts: ExecOptions): ReadResult {
  const guard = new Guard(opts);
  const ctx: EvalContext = { params: opts.params, source: opts.source };

  // Descend past the result-stage operators to the binding subtree.
  let bindingRoot = plan;
  while (!isBindingOp(bindingRoot)) {
    if ('child' in bindingRoot && bindingRoot.child) bindingRoot = bindingRoot.child;
    else break;
  }
  // A WHERE Filter belongs to the binding subtree; result ops were skipped above.

  function* edgesFor(id: number, types: string[], direction: 'out' | 'in' | 'both'): IterableIterator<{ edge: EdgeRecord; other: number }> {
    const typeList: (string | undefined)[] = types.length === 0 ? [undefined] : types;
    const seen = direction === 'both' ? new Set<number>() : undefined;
    for (const t of typeList) {
      if (direction !== 'in')
        for (const e of store.outEdges(id, t)) {
          if (seen) {
            if (seen.has(e.id)) continue;
            seen.add(e.id);
          }
          yield { edge: e, other: e.to };
        }
      if (direction !== 'out')
        for (const e of store.inEdges(id, t)) {
          if (seen) {
            if (seen.has(e.id)) continue;
            seen.add(e.id);
          }
          yield { edge: e, other: e.from };
        }
    }
  }

  function extend(b: Binding, key: string, value: NodeRecord | EdgeRecord): Binding {
    const next = new Map(b);
    next.set(key, value);
    return next;
  }

  function* bindings(node: PlanNode): Generator<Binding> {
    switch (node.op) {
      case 'AllNodesScan': {
        for (const n of store.nodes.values()) {
          guard.bump();
          yield new Map([[node.variable, n]]);
        }
        return;
      }
      case 'LabelScan': {
        for (const n of store.nodesByLabel(node.label)) {
          guard.bump();
          yield new Map([[node.variable, n]]);
        }
        return;
      }
      case 'IndexSeek': {
        const v = evalExpr(node.valueAst, new Map(), ctx);
        if (v === null || Array.isArray(v) || (typeof v === 'object' && !(v instanceof Date))) return;
        for (const id of store.indexes.lookupExact(node.label, node.property, v) ?? []) {
          guard.bump();
          const n = store.getNode(id);
          if (n) yield new Map([[node.variable, n]]);
        }
        return;
      }
      case 'FromBound':
        throw new AqlError('RUNTIME_ERROR', 'unspliced FromBound reached the executor', ORIGIN, opts.source);
      case 'Filter': {
        for (const b of bindings(node.child)) {
          if (evalExpr(node.exprAst, b, ctx) === true) yield b;
        }
        return;
      }
      case 'Expand': {
        for (const b of bindings(node.child)) {
          const from = b.get(node.from) as NodeRecord;
          for (const { edge, other } of edgesFor(from.id, node.types, node.direction)) {
            guard.bump();
            const target = store.getNode(other)!;
            if (!hasAllLabels(target, node.toLabels)) continue;
            const boundTo = b.get(node.to);
            if (boundTo !== undefined && (boundTo as NodeRecord).id !== target.id) continue;
            if (node.edgeVariable !== undefined) {
              const boundEdge = b.get(node.edgeVariable);
              if (boundEdge !== undefined && (boundEdge as EdgeRecord).id !== edge.id) continue;
            }
            let next = boundTo === undefined ? extend(b, node.to, target) : b;
            if (node.edgeVariable !== undefined && b.get(node.edgeVariable) === undefined)
              next = extend(next, node.edgeVariable, edge);
            yield next;
          }
        }
        return;
      }
      case 'VarLengthExpand': {
        for (const b of bindings(node.child)) {
          const from = b.get(node.from) as NodeRecord;
          // One row per distinct edge-unique path with length in [min, max].
          const stack: { id: number; depth: number; used: Set<number> }[] = [
            { id: from.id, depth: 0, used: new Set() },
          ];
          while (stack.length > 0) {
            const cur = stack.pop()!;
            if (cur.depth >= node.min && cur.depth > 0) {
              guard.bump();
              const target = store.getNode(cur.id)!;
              if (hasAllLabels(target, node.toLabels)) {
                const boundTo = b.get(node.to);
                if (boundTo === undefined) yield extend(b, node.to, target);
                else if ((boundTo as NodeRecord).id === target.id) yield b;
              }
            }
            if (cur.depth >= node.max) continue;
            for (const { edge, other } of edgesFor(cur.id, node.types, node.direction)) {
              guard.bump();
              if (cur.used.has(edge.id)) continue;
              stack.push({ id: other, depth: cur.depth + 1, used: new Set(cur.used).add(edge.id) });
            }
          }
        }
        return;
      }
      case 'CartesianProduct': {
        const rights: Binding[] = [...bindings(node.right)];
        for (const l of bindings(node.left)) {
          for (const r of rights) {
            guard.bump();
            const merged = new Map(l);
            for (const [k, v] of r) merged.set(k, v);
            yield merged;
          }
        }
        return;
      }
      default:
        throw new AqlError('RUNTIME_ERROR', `unexpected plan op ${node.op} in binding subtree`, ORIGIN, opts.source);
    }
  }

  // ---- result stage ----
  const columns = query.items.map((it) => it.alias ?? renderExpr(it.expr));
  const aggregating = query.items.some((it) => isAggregateItem(it.expr));
  interface Row {
    values: RuntimeValue[];
    binding?: Binding;
  }
  let rows: Row[] = [];

  if (!aggregating) {
    for (const b of bindings(bindingRoot)) {
      guard.result();
      rows.push({ values: query.items.map((it) => evalExpr(it.expr, b, ctx)), binding: b });
    }
  } else {
    interface Acc {
      count: number;
      sum: number;
      collected: RuntimeValue[];
      collectedKeys: Set<string>;
      min?: RuntimeValue;
      max?: RuntimeValue;
    }
    const newAcc = (): Acc => ({ count: 0, sum: 0, collected: [], collectedKeys: new Set() });
    const groups = new Map<string, { keyValues: Map<number, RuntimeValue>; accs: Map<number, Acc> }>();
    for (const it of query.items)
      if (isAggregateItem(it.expr) && it.expr.kind !== 'call')
        throw new AqlError('SEMANTIC_ERROR', 'aggregates must be top-level RETURN items', it.pos, opts.source);
    for (const b of bindings(bindingRoot)) {
      const keyValues = new Map<number, RuntimeValue>();
      for (const [i, it] of query.items.entries())
        if (!isAggregateItem(it.expr)) keyValues.set(i, evalExpr(it.expr, b, ctx));
      const key = stableKey([...keyValues.values()]);
      let g = groups.get(key);
      if (!g) {
        g = { keyValues, accs: new Map() };
        groups.set(key, g);
      }
      for (const [i, it] of query.items.entries()) {
        if (!isAggregateItem(it.expr)) continue;
        const call = it.expr as Extract<Expr, { kind: 'call' }>;
        let acc = g.accs.get(i);
        if (!acc) {
          acc = newAcc();
          g.accs.set(i, acc);
        }
        const v: RuntimeValue = call.arg === '*' ? true : evalExpr(call.arg, b, ctx);
        if (call.arg !== '*' && v === null) continue; // aggregates skip nulls
        if (call.distinct) {
          const k = stableKey([v]);
          if (acc.collectedKeys.has(k)) continue;
          acc.collectedKeys.add(k);
        }
        acc.count++;
        if (typeof v === 'number') acc.sum += v;
        if (call.func === 'collect') acc.collected.push(v);
        if (call.func === 'min' && (acc.min === undefined || (compareRuntime(v, acc.min) ?? 1) < 0)) acc.min = v;
        if (call.func === 'max' && (acc.max === undefined || (compareRuntime(v, acc.max) ?? -1) > 0)) acc.max = v;
      }
    }
    if (groups.size === 0 && query.items.every((it) => isAggregateItem(it.expr)))
      groups.set('', { keyValues: new Map(), accs: new Map() });
    for (const g of groups.values()) {
      guard.result();
      const values = query.items.map((it, i) => {
        if (!isAggregateItem(it.expr)) return g.keyValues.get(i) ?? null;
        const call = it.expr as Extract<Expr, { kind: 'call' }>;
        const acc = g.accs.get(i) ?? newAcc();
        switch (call.func) {
          case 'count':
            return acc.count;
          case 'collect':
            return acc.collected;
          case 'sum':
            return acc.sum;
          case 'avg':
            return acc.count === 0 ? null : acc.sum / acc.count;
          case 'min':
            return acc.min ?? null;
          default:
            return acc.max ?? null;
        }
      });
      rows.push({ values });
    }
  }

  if (query.distinct) {
    const seen = new Set<string>();
    rows = rows.filter((r) => {
      const k = stableKey(r.values);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  if (query.orderBy.length > 0) {
    const keyFns = query.orderBy.map((o) => {
      const aliasIdx = columns.indexOf(o.expr.kind === 'variable' ? o.expr.name : renderExpr(o.expr));
      return (r: Row): RuntimeValue => {
        if (aliasIdx >= 0) return r.values[aliasIdx]!;
        if (!r.binding)
          throw new AqlError(
            'SEMANTIC_ERROR',
            'ORDER BY on aggregated queries must reference output columns',
            o.expr.pos,
            opts.source,
          );
        return evalExpr(o.expr, r.binding, ctx);
      };
    });
    rows.sort((a, b) => {
      for (const [i, o] of query.orderBy.entries()) {
        const c = compareRuntime(keyFns[i]!(a), keyFns[i]!(b));
        const cc = c === null ? 0 : c;
        if (cc !== 0) return o.desc ? -cc : cc;
      }
      return 0;
    });
  }

  const skip = countOf(query.skip, ctx, opts, 'SKIP');
  const limit = countOf(query.limit, ctx, opts, 'LIMIT');
  if (skip !== undefined || limit !== undefined)
    rows = rows.slice(skip ?? 0, limit === undefined ? undefined : (skip ?? 0) + limit);

  return { columns, rows: rows.map((r) => r.values), stats: { rowsExamined: guard.rowsExamined } };
}

function countOf(e: Expr | undefined, ctx: EvalContext, opts: ExecOptions, what: string): number | undefined {
  if (e === undefined) return undefined;
  const v = evalExpr(e, new Map(), ctx);
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0)
    throw new AqlError('RUNTIME_ERROR', `${what} expects a non-negative integer, got ${String(v)}`, e.pos, opts.source);
  return v;
}

/** Stable dedup/grouping key: records by kind+id, dates by epoch, arrays recursive. */
function stableKey(values: RuntimeValue[]): string {
  return values
    .map((v): string => {
      if (v === null) return '∅';
      if (v instanceof Date) return `D${v.getTime()}`;
      if (Array.isArray(v)) return `[${stableKey(v)}]`;
      if (typeof v === 'object') return ('type' in v ? 'E' : 'N') + v.id;
      return `${typeof v}:${String(v)}`;
    })
    .join('|');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/query/test/exec-basic.test.ts`
Expected: PASS — including the guard test (with `timeoutMs: 0` the guard fires deterministically on the first `bump`).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(query): plan executor — binding generators, aggregation, guards"
```

### Task 8: Executor behavior pins — patterns, joins, aggregates

The executor landed in Task 7; this task pins the trickier semantics with dedicated suites (and fixes `exec.ts` if any case disagrees — tests are the contract).

**Files:**
- Test: `packages/query/test/exec-patterns.test.ts`, `packages/query/test/exec-aggregate.test.ts`

- [ ] **Step 1: Write the pattern tests**

`packages/query/test/exec-patterns.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '@atlas/core';
import { runRead } from '../src/exec.js';
import { parseQuery } from '../src/parser.js';
import { planQuery } from '../src/planner.js';

let dir: string;
let db: AtlasDatabase;
let n: Record<string, number>;

// Chain a->b->c->d (REL), plus c->a closing a cycle, plus disjoint x->y (OTHER).
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-execp-'));
  db = await openDatabase(dir);
  n = {};
  await db.transact((tx) => {
    for (const k of ['a', 'b', 'c', 'd', 'x', 'y']) n[k] = tx.createNode(['V'], { k });
    tx.createEdge('REL', n.a!, n.b!);
    tx.createEdge('REL', n.b!, n.c!);
    tx.createEdge('REL', n.c!, n.d!);
    tx.createEdge('REL', n.c!, n.a!);
    tx.createEdge('OTHER', n.x!, n.y!);
  });
});
afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

function run(src: string) {
  const { query } = parseQuery(src);
  return runRead(planQuery(query, db.graphStore), query, db.graphStore, {
    params: {},
    source: src,
    timeoutMs: 10_000,
    maxRows: 100_000,
  });
}

describe('variable-length expansion', () => {
  it('*1..2 yields one row per edge-unique path', () => {
    const r = run(`MATCH (s:V {k: 'a'})-[:REL*1..2]->(t) RETURN t.k ORDER BY t.k`);
    expect(r.rows.map((row) => row[0])).toEqual(['b', 'c']); // a->b, a->b->c
  });

  it('min bound excludes shorter paths; cycles do not loop forever (edge-unique)', () => {
    const r = run(`MATCH (s:V {k: 'a'})-[:REL*3..4]->(t) RETURN t.k ORDER BY t.k`);
    // a->b->c->d (len 3), a->b->c->a (len 3, returns to start) — edge-uniqueness ends there.
    expect(r.rows.map((row) => row[0])).toEqual(['a', 'd']);
  });

  it('bound endpoints filter paths: cycle detection via shared variable', () => {
    const r = run(`MATCH (s:V {k: 'a'})-[:REL*1..4]->(s) RETURN count(*)`);
    expect(r.rows).toEqual([[1]]); // exactly the a->b->c->a cycle
  });
});

describe('multi-pattern joins', () => {
  it('shared variables continue the stream (no cartesian blowup)', () => {
    const r = run(`MATCH (s:V {k: 'a'})-[:REL]->(m), (m)-[:REL]->(t) RETURN t.k`);
    expect(r.rows).toEqual([['c']]);
  });

  it('disjoint patterns produce the full cartesian product', () => {
    const r = run(`MATCH (p:V {k: 'a'}), (q:V {k: 'x'})-[:OTHER]->(z) RETURN p.k, z.k`);
    expect(r.rows).toEqual([['a', 'y']]);
  });

  it('repeated node variable inside one pattern must re-match the same node', () => {
    // Anchored start (orchestrator decision below): no (V, k) index exists, so the
    // planner narrows the start via LabelScan(V) + Filter(s.k='a') to the single
    // node `a`. The closing -[:REL]->(s) re-binds that same node via the
    // executor's boundTo re-match check, so the directed 3-cycle a->b->c->a yields
    // exactly one binding.
    const r = run(`MATCH (s:V {k: 'a'})-[:REL]->(m)-[:REL]->(e)-[:REL]->(s) RETURN s.k, m.k, e.k`);
    expect(r.rows).toEqual([['a', 'b', 'c']]); // the only 3-cycle
  });
});
```

> **Orchestrator decision (Task 8 review, 2026-06-13):** the originally-drafted
> query `MATCH (s)-[:REL]->(m)-[:REL]->(e)-[:REL]->(s)` left `(s)` anonymous, so
> the planner emitted an AllNodesScan and enumerated the single directed 3-cycle
> once per cycle member — three rotational bindings of `(s,m,e)`, not the
> hand-derived `[['a','b','c']]`. The implementer correctly surfaced this. Per
> the review, the fix is to **anchor the start with `(s:V {k:'a'})`**. The
> fixture creates no scalar index on (V, k), so the planner narrows the start via
> `LabelScan(V) + Filter(s.k='a')` to the single matching node `a` (verified by
> dumping `serializePlan` — it is LabelScan+Filter, not an IndexSeek; an
> IndexSeek would only appear if a property/unique index on (V, k) existed). The
> closing `-[:REL]->(s)` then re-binds that same anchored node via the executor's
> `boundTo` re-match check (`exec.ts`), which behaves identically under LabelScan
> and IndexSeek. This yields exactly one binding `[['a','b','c']]` — preserving
> the spec-literal expected value and the re-match invariant the case was
> pinning. No rotation-non-deduplication semantics are introduced.

- [ ] **Step 2: Write the aggregate tests**

`packages/query/test/exec-aggregate.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '@atlas/core';
import { runRead } from '../src/exec.js';
import { parseQuery } from '../src/parser.js';
import { planQuery } from '../src/planner.js';

let dir: string;
let db: AtlasDatabase;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-execa-'));
  db = await openDatabase(dir);
  await db.transact((tx) => {
    const ada = tx.createNode(['Person'], { name: 'Ada', field: 'math' });
    const em = tx.createNode(['Person'], { name: 'Emmy', field: 'math' });
    const marie = tx.createNode(['Person'], { name: 'Marie', field: 'physics' });
    for (let i = 0; i < 3; i++) tx.createEdge('WROTE', ada, tx.createNode(['Doc'], { pages: 10 * (i + 1) }));
    for (let i = 0; i < 2; i++) tx.createEdge('WROTE', em, tx.createNode(['Doc'], { pages: 5 }));
    tx.createEdge('WROTE', marie, tx.createNode(['Doc'], { pages: 100 }));
  });
});
afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

function run(src: string) {
  const { query } = parseQuery(src);
  return runRead(planQuery(query, db.graphStore), query, db.graphStore, {
    params: {},
    source: src,
    timeoutMs: 10_000,
    maxRows: 100_000,
  });
}

describe('aggregation', () => {
  it('implicit grouping by the non-aggregate items (the spec example shape)', () => {
    const r = run(
      'MATCH (p:Person)-[:WROTE]->(d:Doc) RETURN p.name, count(d) AS works ORDER BY works DESC',
    );
    expect(r.columns).toEqual(['p.name', 'works']);
    expect(r.rows).toEqual([
      ['Ada', 3],
      ['Emmy', 2],
      ['Marie', 1],
    ]);
  });

  it('sum/avg/min/max/collect over groups', () => {
    const r = run(
      'MATCH (p:Person)-[:WROTE]->(d:Doc) RETURN p.field AS f, sum(d.pages) AS s, avg(d.pages) AS a, min(d.pages) AS lo, max(d.pages) AS hi ORDER BY f',
    );
    expect(r.rows).toEqual([
      ['math', 70, 14, 5, 30],
      ['physics', 100, 100, 100, 100],
    ]);
    const c = run("MATCH (p:Person {field: 'math'}) RETURN collect(p.name) AS names");
    expect((c.rows[0]![0] as string[]).sort()).toEqual(['Ada', 'Emmy']);
  });

  it('count(*) vs count(x) vs count(DISTINCT x)', () => {
    const r = run('MATCH (p:Person)-[:WROTE]->(d:Doc) RETURN count(*), count(d.pages), count(DISTINCT d.pages)');
    expect(r.rows).toEqual([[6, 6, 5]]); // pages 5 repeats
  });

  it('all-aggregate query over an empty match returns one zero row', () => {
    const r = run("MATCH (p:Person {name: 'Nobody'}) RETURN count(*) AS c, sum(p.born) AS s");
    expect(r.rows).toEqual([[0, 0]]);
  });

  it('grouped query over empty match returns no rows', () => {
    expect(run("MATCH (p:Person {name: 'Nobody'}) RETURN p.name, count(*)").rows).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the suites**

Run: `pnpm vitest run packages/query/test/exec-patterns.test.ts packages/query/test/exec-aggregate.test.ts`
Expected: PASS. Any failure is a real executor bug — fix `exec.ts` (likely suspects: edge-unique path enumeration order, bound-variable re-match in expands, group key collisions), never the expected values: each is hand-derivable from the fixture graphs.

- [ ] **Step 4: Full gate, then commit**

Run: `pnpm build && pnpm typecheck:test && pnpm lint && pnpm format && pnpm test`
Expected: all green.

```bash
git add -A
git commit -m "test(query): pin variable-length, join, and aggregation semantics"
```

### Task 9: Public API + science-history integration

**Files:**
- Create: `packages/query/src/api.ts`
- Modify: `packages/query/package.json` (devDependency `"@atlas/datasets": "workspace:*"`)
- Test: `packages/query/test/api.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/query/test/api.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '@atlas/core';
import { loadDataset, scienceHistory } from '@atlas/datasets';
import { executeQuery, explainQuery } from '../src/api.js';
import { AqlError } from '../src/errors.js';

let dir: string;
let db: AtlasDatabase;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-api-'));
  db = await openDatabase(dir, { fsync: { intervalMs: 1000 } });
  await loadDataset(db, scienceHistory());
  await db.createIndex({ kind: 'property', label: 'Person', property: 'name' });
});
afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('executeQuery over science-history', () => {
  it('runs the spec headline query shape', async () => {
    const r = await executeQuery(
      db,
      "MATCH (p:Person)-[:WROTE]->(d:Document)\nWHERE d.year > 1840\nRETURN p.name, count(d) AS works\nORDER BY works DESC LIMIT 5",
    );
    expect(r.columns).toEqual(['p.name', 'works']);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.length).toBeLessThanOrEqual(5);
    const counts = r.rows.map((row) => row[1] as number);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts); // descending
    expect(r.stats.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('uses the index for parameterized name lookups', async () => {
    const r = await executeQuery(db, 'MATCH (p:Person {name: $who}) RETURN p.born', {
      params: { who: 'Ada Lovelace' },
    });
    expect(r.rows).toEqual([[1815]]);
    expect(r.stats.rowsExamined).toBeLessThan(5);
  });

  it('variable-length CITES reaches concepts transitively', async () => {
    const r = await executeQuery(
      db,
      "MATCH (d:Document)-[:CITES*1..2]->(c:Concept) WHERE d.year < 1850 RETURN count(*) AS n",
    );
    expect((r.rows[0]![0] as number)).toBeGreaterThan(0);
  });

  it('EXPLAIN prefix returns the plan instead of rows', async () => {
    const r = await executeQuery(db, "EXPLAIN MATCH (p:Person {name: 'Ada Lovelace'}) RETURN p");
    expect(r.columns).toEqual(['plan']);
    const plan = JSON.stringify(r.rows[0]![0]);
    expect(plan).toContain('"op":"IndexSeek"');
    expect(plan).not.toContain('Ast');
  });

  it('explainQuery helper works with or without the EXPLAIN keyword', () => {
    const a = explainQuery(db, 'MATCH (p:Person) RETURN p');
    const b = explainQuery(db, 'EXPLAIN MATCH (p:Person) RETURN p');
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toContain('"op":"LabelScan"');
  });

  it('errors carry position + snippet through the public API', async () => {
    try {
      await executeQuery(db, 'MATCH (p:Person RETURN p');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AqlError);
      const err = e as AqlError;
      expect(err.code).toBe('PARSE_ERROR');
      expect(err.snippet).toContain('^');
    }
    await expect(executeQuery(db, 'MATCH (p:Person) RETURN p', { maxRows: 3 })).rejects.toMatchObject(
      { code: 'ROW_LIMIT' },
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm install && pnpm build && pnpm vitest run packages/query/test/api.test.ts`
Expected: FAIL — `api.js` not found (install first: the new `@atlas/datasets` devDependency must link).

- [ ] **Step 3: Implement**

`packages/query/src/api.ts`:

```ts
import type { AtlasDatabase } from '@atlas/core';
import { runRead } from './exec.js';
import { parseQuery } from './parser.js';
import { serializePlan } from './plan.js';
import { planQuery } from './planner.js';

export interface QueryOptions {
  params?: Record<string, unknown>;
  /** Per-query wall-clock budget. Default 30s. */
  timeoutMs?: number;
  /** Maximum result rows; exceeding raises ROW_LIMIT (never silent truncation). Default 100k. */
  maxRows?: number;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  stats: { rowsExamined: number; elapsedMs: number };
}

/**
 * Parse, plan, and execute an AQL read query. `EXPLAIN <query>` returns a
 * single `plan` column holding the serialized plan JSON instead of results.
 * Async for wire-compatibility with M4b (CALL algo.*); reads execute
 * synchronously inside.
 */
export async function executeQuery(
  db: AtlasDatabase,
  text: string,
  opts: QueryOptions = {},
): Promise<QueryResult> {
  const started = performance.now();
  const parsed = parseQuery(text);
  const plan = planQuery(parsed.query, db.graphStore);
  if (parsed.explain) {
    return {
      columns: ['plan'],
      rows: [[serializePlan(plan)]],
      stats: { rowsExamined: 0, elapsedMs: Math.round(performance.now() - started) },
    };
  }
  const result = runRead(plan, parsed.query, db.graphStore, {
    params: opts.params ?? {},
    source: text,
    timeoutMs: opts.timeoutMs ?? 30_000,
    maxRows: opts.maxRows ?? 100_000,
  });
  return {
    columns: result.columns,
    rows: result.rows,
    stats: { rowsExamined: result.stats.rowsExamined, elapsedMs: Math.round(performance.now() - started) },
  };
}

/** The plan a query would run with, as plain JSON (the EXPLAIN payload). */
export function explainQuery(db: AtlasDatabase, text: string): Record<string, unknown> {
  const parsed = parseQuery(text);
  return serializePlan(planQuery(parsed.query, db.graphStore));
}
```

Add to `packages/query/package.json`:

```json
  "devDependencies": { "@atlas/datasets": "workspace:*" }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/query/test/api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(query): executeQuery/explainQuery public API with science-history coverage"
```

### Task 10: Exports, README, full gate

**Files:**
- Modify: `packages/query/src/index.ts`, `README.md`

- [ ] **Step 1: Finalize the public surface**

Replace `packages/query/src/index.ts`:

```ts
export { executeQuery, explainQuery, type QueryOptions, type QueryResult } from './api.js';
export {
  AGGREGATES,
  SCALAR_FUNCS,
  walkExpr,
  type EdgePattern,
  type Expr,
  type NodePattern,
  type ParsedQuery,
  type PathPattern,
  type ReadQuery,
  type ReturnItem,
} from './ast.js';
export { AqlError, renderSnippet, type AqlErrorCode } from './errors.js';
export { runRead, type ExecOptions, type ReadResult } from './exec.js';
export { evalExpr, type Binding, type RuntimeValue } from './eval.js';
export { lex, type Token, type TokenType } from './lexer.js';
export { parseExpression, parseQuery, TokenStream } from './parser.js';
export { renderExpr, serializePlan, type PlanNode } from './plan.js';
export { planQuery } from './planner.js';
```

- [ ] **Step 2: Update README status**

In `README.md`, update the `**Status:**` block to:

```markdown
**Status:** M4a — AQL read pipeline (`@atlas/query`): lexer → parser →
selectivity-based planner (EXPLAIN as JSON) → guarded executor. MATCH with
variable-length hops, WHERE, RETURN aggregations, ORDER BY/SKIP/LIMIT,
$parameters, caret-annotated errors. Writes/DDL/CALL land in M4b.
```

- [ ] **Step 3: Full gate**

Run: `pnpm build && pnpm typecheck:test && pnpm lint && pnpm format && pnpm test`
Expected: all green across all four packages.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(query): finalize M4a public exports and README"
```

---

## Plan self-review notes

- **Spec coverage (M4a scope):** §5.2 read surface — MATCH multi-hop/var-length/multi-pattern (T4, T7, T8), WHERE operators (T3, T5), RETURN + aggregations + DISTINCT + AS (T4, T7, T8), ORDER BY/SKIP/LIMIT (T4, T7), `$parameters` (T3, T5, T9), EXPLAIN as structured JSON (T6, T9); §5.3 pure pipeline, planner picks index starts by selectivity incl. WHERE-conjunct equality extraction (T6); §5.4 error shape `{code,message,line,column,snippet}` + caret (T1) and timeout/max-rows guards at iterator boundaries (T7). Writes/DDL/CALL explicitly deferred to M4b (parser rejects).
- **Deliberate v1 semantics (documented in-plan, not bugs):** strict null handling (comparisons with null are false — not Cypher 3VL); type-strict equality; no arithmetic expressions; var-length edges bind no variable, hop cap 15 (default 8 for bare `*`), edge-unique paths; ORDER BY on aggregated queries must reference output columns; aggregates only as top-level RETURN items; inline pattern props are literals/params only; `maxRows` raises ROW_LIMIT rather than truncating.
- **Type anchors:** `parseQuery(source) → { explain, query }`; `planQuery(query, store) → PlanNode` (Ast-suffixed fields are executor-only; `serializePlan` strips them); `runRead(plan, query, store, {params, source, timeoutMs, maxRows})`; `evalExpr(expr, Binding, {params, source})`; Guard bumps per binding, `result()` per emitted row; `executeQuery` is async, `explainQuery` sync.
- **Plan-level fixes from self-review:** the joined-pattern planner test asserts the *absence* of `CartesianProduct` (the `FromBound` leaf is spliced away — asserting its presence was a bug); `timeoutMs <= 0` fires deterministically on the first `bump()` (zero-delay macrotask timers can never beat a synchronous executor).




