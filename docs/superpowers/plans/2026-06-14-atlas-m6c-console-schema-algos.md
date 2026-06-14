# Atlas M6c — Knowledge Graph Explorer: AQL Console, Schema View, Algorithms View

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the three knowledge-discovery surfaces of the workspace, integrated alongside the M6b graph canvas: a bottom-dock **AQL console** (CodeMirror 6 editor with AQL syntax highlighting, schema-aware autocomplete, error squiggles, ⌘/Ctrl+Enter to run; tabs Results table / visual EXPLAIN Plan / History; results projectable onto the canvas), a **Schema view** (auto-generated diagram of labels with counts and edge types from `Database.schema()` introspection), and an **Algorithms view** (parameter forms for the v1 algorithm set run via `CALL algo.*`, with results painted onto the canvas — node size = score, color = community, highlighted paths). Parsing/tokenizing/completion/plan-transform/history/schema-layout/algorithm-spec stay PLAIN-TS modules unit-tested in Vitest; Angular + CodeMirror are thin wrappers smoke-tested via `ng test`; one Playwright e2e (open console → run a query → see results table; open schema view) is excluded from the default gate.

**Architecture:** Everything talks to the server only through the existing `AtlasApi` service (M6a), which wraps a cookie-mode `@atlas/client`: `api.database(name)` returns a `Database` with `.query(aql, params) → QueryResponse` and `.schema() → SchemaSummary`. The console runs queries (and `EXPLAIN <query>`) through `Database.query`; `AqlError` surfaces as RFC 7807 problem-details on the thrown `AtlasClientError` (`{ code, line, column, snippet }`), which the console renders as inline squiggles + a message with caret position. The CodeMirror editor is wrapped in an Angular component, but all the testable logic — the AQL tokenizer, the completion-source function, the EXPLAIN plan→view-model transform, the history store, the schema diagram layout, and the algorithm spec/argument builder — lives in framework-free TypeScript files unit-tested under jsdom. M6c **consumes** the M6b workspace graph store through a narrow, named interface (`WorkspaceGraphStore`, see anchors): the console calls `store.setGraph(...)` to project result nodes/edges onto the canvas, and the algorithms view calls `store.paintAlgorithmResult(...)` to size/color/highlight. Because M6b is being authored concurrently and may not exist yet, M6c declares this interface in `apps/web/src/app/workspace/workspace-graph-store.contract.ts` (a pure interface + an in-memory fake for tests) and depends only on it — M6b implements the same interface or M6c adapts in M6d (boundary noted below).

**Tech Stack:** Existing stack (Node 24, pnpm 9.15.4, TypeScript, Vitest, ESLint, Prettier) + Angular 20.3 (standalone, signals, zoneless) from M6a, plus **CodeMirror 6** for the AQL editor: `@codemirror/state@^6`, `@codemirror/view@^6`, `@codemirror/language@^6`, `@codemirror/autocomplete@^6`, `@codemirror/commands@^6`. Library logic tests run via the app's `@angular/build:unit-test` Vitest runner under jsdom (`pnpm -F web exec ng test --watch=false`). Playwright for the e2e (already wired in M6a). The graph canvas renderer (M6b), node/edge CRUD inspector (M6b), and admin/import UI + final theming polish (M6d) are **out of scope here.**

**Spec:** `docs/superpowers/specs/2026-06-10-atlas-graph-platform-design.md`:
- §7.2 Workspace bottom-dock AQL console — "editor with highlighting + schema-aware autocomplete + error squiggles; tabs: Results table, visual EXPLAIN Plan, History; results can also be projected onto the canvas" → Tasks 1–6.
- §7.2 Schema view — "auto-generated diagram of labels and edge types from introspection (§4.6)" → Task 7.
- §7.2 Algorithms view — "parameter forms for the algorithm set; results painted onto the canvas (node size = score, color = community, highlighted paths)" → Task 8.
- §5.2 AQL — clause surface (keywords for highlighting/autocomplete), the pinned `CALL algo.<name>` signature table (the algorithms view's parameter forms), and `EXPLAIN <query>` → "logical plan as structured JSON (rendered visually in the explorer)" → Tasks 1, 4, 8.
- §4.6 Schema introspection — labels with counts, property names/types/frequencies, edge types with from/to label distributions → Tasks 2, 7.
- §4.7 Algorithms — the v1 set (BFS/DFS, shortest/all-shortest paths, PageRank, components, Louvain, degree, betweenness, topoSort, cycles) → Task 8.
- §5.4 Errors — every parse/runtime error carries `{ code, message, line, column, snippet }` with a caret → Task 3 (squiggles).

**Existing code anchors (verified against the source tree):**
- `@atlas/client` (`packages/client/src/index.ts`, M6a): `connect(url, { mode: 'cookie' }) → AtlasClient`; `AtlasClient.database(name) → Database`; `Database.query(aql, params = {}) → Promise<QueryResponse>`, `Database.schema() → Promise<SchemaSummary>`; errors thrown as `AtlasClientError { code: string; status: number; message: string; problem?: ProblemDetails }`.
- `AtlasApi` (`apps/web/src/app/core/atlas-api.ts`, M6a): `database(name) → Database` (returns the `@atlas/client` `Database`). M6c calls `api.database(name).query(...)` / `.schema()`.
- `QueryResponse` / `QueryResult` (`packages/protocol/src/wire.ts` + `packages/query/src/api.ts`): `{ columns: string[]; rows: unknown[][]; stats: { rowsExamined: number; elapsedMs: number; created?: number; deleted?: number; propsSet?: number } }`. **Row-cell shapes (verified):** a returned node is a `NodeRecord` serialized as `{ id: number; labels: string[]; props: Record<string, unknown> }`; a returned edge is an `EdgeRecord` `{ id: number; type: string; from: number; to: number; props: Record<string, unknown> }`. (Query rows pass `executeQuery`'s result through untouched, so they carry `props`, **not** `properties` — the latter is only the node/edge REST CRUD shape.)
- `EXPLAIN <query>` (`packages/query/src/api.ts` + `plan.ts`): returns `{ columns: ['plan'], rows: [[planJson]] }`. `planJson` is the serialized `PlanNode` tree — a recursive object with `op: string`, scalar fields (e.g. `variable`, `label`, `estCost`), and child links under `child` (unary), `left`/`right` (binary CartesianProduct). Write/DDL/Call statements EXPLAIN to flat `{ op: 'Write'|'Ddl'|'Call', … }` shapes.
- `AqlError` (`packages/query/src/errors.ts`): codes `'PARSE_ERROR' | 'SEMANTIC_ERROR' | 'RUNTIME_ERROR' | 'TIMEOUT' | 'ROW_LIMIT'`; `{ line, column, snippet }`. Mapped by the server (`packages/server/src/errors.ts`) into `ProblemDetails { code, line?, column?, snippet?, detail }` (HTTP 400 for parse/semantic/runtime). `AtlasClientError.problem` carries these through to the app.
- `SchemaSummary` (`packages/core/src/schema.ts`): `{ labels: { label: string; count: number; properties: { property: string; types: Record<string, number> }[] }[]; edgeTypes: { type: string; count: number; from: Record<string, number>; to: Record<string, number> }[] }`.
- `CALL algo.*` (`packages/query/src/call.ts`, verified): YIELD columns — `algo.pagerank`/`algo.degree`/`algo.betweenness` → `node` (a **NodeId number**), `score`; `algo.louvain` → `node`, `community`; `algo.components(mode)` → `node`, `component`; `algo.bfs`/`algo.dfs(from,type?,maxDepth?)` → `node`, `depth`; `algo.topoSort(type?)` → `node`, `order`; `algo.shortestPath(from,to,weightProp?)` → `path` (a `PathResult { nodes: number[]; edges: number[] }`), `cost`; `algo.allShortestPaths(from,to,type?)` → `path`, `cost`; `algo.cycles(type?)` → `cycle` (a `PathResult`). **Algorithm `node` cells are bare numbers, not node objects** — the algorithms view maps id→score/community for painting.
- **M6b dependency (NOT YET WRITTEN):** the workspace graph store that owns the canvas's displayed node/edge set. M6b will export a store with (at minimum) a method to load/replace the displayed graph and a method to paint algorithm results. Since `2026-06-14-atlas-m6b-workspace-canvas.md` is absent at authoring time, M6c **defines** the minimal interface it needs (`WorkspaceGraphStore`) in Task 6 and consumes only that. M6b is expected to implement the same interface (or an M6d adapter bridges them). **Boundary noted in the self-review.**

## File structure

```
apps/web/
  package.json            MODIFY: add @codemirror/{state,view,language,autocomplete,commands}@^6
  src/app/workspace/
    aql-language.ts                 CREATE (T1): plain-TS AQL tokenizer + CodeMirror StreamLanguage + keyword list
    aql-language.spec.ts            CREATE (T1)
    aql-editor.ts                   CREATE (T1): Angular CodeMirror 6 wrapper (no template file — host element)
    aql-editor.spec.ts              CREATE (T1): smoke (mounts, emits value, run on Ctrl+Enter)
    aql-completions.ts              CREATE (T2): pure completion-source from SchemaSummary + keywords
    aql-completions.spec.ts         CREATE (T2)
    console.store.ts                CREATE (T3): run/results/error signal store (uses AtlasApi + WorkspaceGraphStore)
    console.store.spec.ts           CREATE (T3, +T6 projection cases)
    results-table.ts / results-table.html   CREATE (T3): Results table tab
    cell-format.ts                  CREATE (T3): pure cell→display + node/edge detection helpers
    cell-format.spec.ts             CREATE (T3)
    explain-plan.ts                 CREATE (T4): pure plan JSON → tree view-model transform
    explain-plan.spec.ts            CREATE (T4)
    explain-plan-view.ts / .html    CREATE (T4): EXPLAIN Plan tab (renders the tree view-model)
    history.store.ts                CREATE (T5): recent-queries store persisted to localStorage
    history.store.spec.ts           CREATE (T5)
    console.ts / console.html       CREATE (T3→T5): the bottom-dock console host (editor + tab bar + tabs)
    console.spec.ts                 CREATE (T3): console host smoke
    workspace-graph-store.contract.ts   CREATE (T6): WorkspaceGraphStore interface + result→graph projection + in-memory fake
    workspace-graph-store.contract.spec.ts  CREATE (T6)
    schema-diagram.ts               CREATE (T7): pure SchemaSummary → diagram view-model (positions, edges)
    schema-diagram.spec.ts          CREATE (T7)
    schema-view.ts / schema-view.html   CREATE (T7): Schema view route (SVG render of the diagram view-model)
    algorithms.ts                   CREATE (T8): pure algorithm-spec catalog + CALL-AQL builder + result-paint mapper
    algorithms.spec.ts              CREATE (T8)
    algorithms-view.ts / .html      CREATE (T8): Algorithms view route (parameter forms; runs + paints)
  src/app/app.routes.ts   MODIFY (T7/T8): add /db/:name/schema and /db/:name/algorithms child routes
  e2e/console.spec.ts     CREATE (T8): Playwright smoke (open console, run a query, see results; open schema view)
README.md                 MODIFY (T8): status → M6c
```

Conventions (inherited from M6a, unchanged): Angular code uses bare import specifiers (no `.js` suffix); the app is zoneless + signals. NEVER run bare `vitest` — the app suite runs via `pnpm -F web exec ng test --watch=false`. Commits end with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Prettier config `{ singleQuote: true, printWidth: 100 }`. The pure-logic modules (`aql-language`, `aql-completions`, `cell-format`, `explain-plan`, `history.store`, `workspace-graph-store.contract`, `schema-diagram`, `algorithms`) import nothing from Angular except, where noted, `@angular/core` `signal`/`Injectable` for the stores; CodeMirror imports live only in `aql-language.ts` (extension factory) and `aql-editor.ts` (the wrapper).

---

### Task 1: AQL editor — CodeMirror 6 wrapper + plain-TS tokenizer/highlighting

Ship the AQL language layer as a framework-free module: a keyword list, a `StreamLanguage` tokenizer for AQL keywords/strings/numbers/operators/parameters/comments, and a CodeMirror `LanguageSupport`. Then wrap CodeMirror 6 in a thin Angular component that mounts an `EditorView`, two-way-binds the document text via signals, and runs on ⌘/Ctrl+Enter. The tokenizer is unit-tested directly (no editor); the component is smoke-tested.

**Files:**
- Modify: `apps/web/package.json`
- Create: `apps/web/src/app/workspace/aql-language.ts`, `apps/web/src/app/workspace/aql-editor.ts`
- Test: `apps/web/src/app/workspace/aql-language.spec.ts`, `apps/web/src/app/workspace/aql-editor.spec.ts`

- [ ] **Step 1: Add the CodeMirror dependencies**

```bash
pnpm -F web add @codemirror/state@^6 @codemirror/view@^6 @codemirror/language@^6 @codemirror/autocomplete@^6 @codemirror/commands@^6
pnpm install
```

These are the canonical CodeMirror 6 packages and resolve cleanly. `@lezer/highlight` (a transitive dep of `@codemirror/language`) supplies the `tags` used by the highlight style; it does not need a direct entry, but if the bundler complains about an unresolved `@lezer/highlight`, add it explicitly: `pnpm -F web add @lezer/highlight@^1`.

- [ ] **Step 2: Write the failing tokenizer test**

`apps/web/src/app/workspace/aql-language.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AQL_KEYWORDS, AQL_FUNCTIONS, tokenizeAql, type AqlToken } from './aql-language';

function kinds(src: string): Array<[string, AqlToken['kind']]> {
  return tokenizeAql(src).map((t) => [t.text, t.kind]);
}

describe('AQL keyword list', () => {
  it('includes the §5.2 clause keywords and is upper-cased + unique', () => {
    for (const kw of ['MATCH', 'WHERE', 'RETURN', 'CREATE', 'MERGE', 'SET', 'DELETE', 'EXPLAIN'])
      expect(AQL_KEYWORDS).toContain(kw);
    expect(new Set(AQL_KEYWORDS).size).toBe(AQL_KEYWORDS.length);
    expect(AQL_KEYWORDS.every((k) => k === k.toUpperCase())).toBe(true);
  });

  it('exposes the aggregate function names from §5.2', () => {
    for (const fn of ['count', 'collect', 'sum', 'avg', 'min', 'max'])
      expect(AQL_FUNCTIONS).toContain(fn);
  });
});

describe('tokenizeAql', () => {
  it('classifies keywords case-insensitively', () => {
    expect(kinds('match (n) return n')).toEqual([
      ['match', 'keyword'],
      ['(', 'punctuation'],
      ['n', 'identifier'],
      [')', 'punctuation'],
      ['return', 'keyword'],
      ['n', 'identifier'],
    ]);
  });

  it('classifies strings, numbers, params, labels, and operators', () => {
    expect(kinds("WHERE n.born >= 1800 AND n.name = 'Ada' OR n.id IN $ids")).toEqual([
      ['WHERE', 'keyword'],
      ['n', 'identifier'],
      ['.', 'punctuation'],
      ['born', 'identifier'],
      ['>=', 'operator'],
      ['1800', 'number'],
      ['AND', 'keyword'],
      ['n', 'identifier'],
      ['.', 'punctuation'],
      ['name', 'identifier'],
      ['=', 'operator'],
      ["'Ada'", 'string'],
      ['OR', 'keyword'],
      ['n', 'identifier'],
      ['.', 'punctuation'],
      ['id', 'identifier'],
      ['IN', 'keyword'],
      ['$ids', 'parameter'],
    ]);
  });

  it('tokenizes a label after a colon and a line comment', () => {
    const t = tokenizeAql('MATCH (p:Person) // find people');
    expect(t.find((x) => x.text === ':Person')?.kind).toBe('label');
    expect(t.at(-1)).toMatchObject({ kind: 'comment', text: '// find people' });
  });

  it('does not choke on an unterminated string (emits a string token to EOL)', () => {
    expect(tokenizeAql("RETURN 'oops").at(-1)).toMatchObject({ kind: 'string', text: "'oops" });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm -F web exec ng test --watch=false`
Expected: FAIL — `./aql-language` not found.

- [ ] **Step 4: Implement `apps/web/src/app/workspace/aql-language.ts`**

```ts
import { StreamLanguage, LanguageSupport, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/** §5.2 clause + operator keywords, upper-cased; matching is case-insensitive at tokenize time. */
export const AQL_KEYWORDS: readonly string[] = [
  'MATCH', 'OPTIONAL', 'WHERE', 'RETURN', 'DISTINCT', 'AS', 'ORDER', 'BY', 'ASC', 'DESC',
  'SKIP', 'LIMIT', 'CREATE', 'MERGE', 'SET', 'REMOVE', 'DELETE', 'DETACH', 'ON',
  'AND', 'OR', 'NOT', 'IN', 'CONTAINS', 'STARTS', 'ENDS', 'WITH', 'EXISTS',
  'INDEX', 'UNIQUE', 'CONSTRAINT', 'FULLTEXT', 'SHOW', 'INDEXES', 'CONSTRAINTS', 'DROP',
  'CALL', 'YIELD', 'EXPLAIN', 'TRUE', 'FALSE', 'NULL',
];

/** §5.2 aggregate/utility function names (lower-cased; used for completion + highlight). */
export const AQL_FUNCTIONS: readonly string[] = ['count', 'collect', 'sum', 'avg', 'min', 'max', 'labels', 'type', 'id'];

const KEYWORD_SET = new Set(AQL_KEYWORDS);

export interface AqlToken {
  text: string;
  /** 0-based start offset within the source. */
  start: number;
  kind: 'keyword' | 'identifier' | 'number' | 'string' | 'parameter' | 'label' | 'operator' | 'punctuation' | 'comment';
}

const OPERATOR_CHARS = new Set(['<', '>', '=', '!', '+', '-', '*', '/']);
const PUNCTUATION = new Set(['(', ')', '[', ']', '{', '}', ',', '.', ':', ';']);

function isIdentStart(c: string): boolean {
  return /[A-Za-z_]/.test(c);
}
function isIdentPart(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c);
}

/**
 * A small hand-written AQL tokenizer (deliberately lightweight — a full lezer
 * grammar is not warranted for v1 highlighting; see plan self-review). Always
 * makes progress and tolerates unterminated strings (emits to end-of-line).
 */
export function tokenizeAql(src: string): AqlToken[] {
  const out: AqlToken[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }
    // Line comment // … to EOL.
    if (c === '/' && src[i + 1] === '/') {
      let j = i + 2;
      while (j < src.length && src[j] !== '\n') j++;
      out.push({ text: src.slice(i, j), start: i, kind: 'comment' });
      i = j;
      continue;
    }
    // Parameter $name.
    if (c === '$') {
      let j = i + 1;
      while (j < src.length && isIdentPart(src[j]!)) j++;
      out.push({ text: src.slice(i, j), start: i, kind: 'parameter' });
      i = j;
      continue;
    }
    // String 'literal' or "literal" (unterminated → to EOL).
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j++;
      const end = j < src.length && src[j] === c ? j + 1 : j;
      out.push({ text: src.slice(i, end), start: i, kind: 'string' });
      i = end;
      continue;
    }
    // Label :Name (colon immediately followed by an identifier).
    if (c === ':' && i + 1 < src.length && isIdentStart(src[i + 1]!)) {
      let j = i + 1;
      while (j < src.length && isIdentPart(src[j]!)) j++;
      out.push({ text: src.slice(i, j), start: i, kind: 'label' });
      i = j;
      continue;
    }
    // Number (integer or decimal).
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j++;
      out.push({ text: src.slice(i, j), start: i, kind: 'number' });
      i = j;
      continue;
    }
    // Identifier or keyword.
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < src.length && isIdentPart(src[j]!)) j++;
      const text = src.slice(i, j);
      out.push({ text, start: i, kind: KEYWORD_SET.has(text.toUpperCase()) ? 'keyword' : 'identifier' });
      i = j;
      continue;
    }
    // Multi-char operators (<=, >=, <>, !=) then single operators.
    if (OPERATOR_CHARS.has(c)) {
      const two = src.slice(i, i + 2);
      if (['<=', '>=', '<>', '!='].includes(two)) {
        out.push({ text: two, start: i, kind: 'operator' });
        i += 2;
        continue;
      }
      out.push({ text: c, start: i, kind: 'operator' });
      i++;
      continue;
    }
    if (PUNCTUATION.has(c)) {
      out.push({ text: c, start: i, kind: 'punctuation' });
      i++;
      continue;
    }
    // Unknown char — consume one so we always progress.
    out.push({ text: c, start: i, kind: 'punctuation' });
    i++;
  }
  return out;
}

/** CodeMirror StreamLanguage built on the same token classification. */
export const aqlStreamLanguage = StreamLanguage.define<unknown>({
  token(stream) {
    if (stream.eatSpace()) return null;
    const rest = stream.string.slice(stream.pos);
    const tok = tokenizeAql(rest)[0];
    if (!tok || tok.start !== 0) {
      stream.next();
      return null;
    }
    stream.pos += tok.text.length;
    switch (tok.kind) {
      case 'keyword':
        return 'keyword';
      case 'number':
        return 'number';
      case 'string':
        return 'string';
      case 'parameter':
        return 'variableName.special';
      case 'label':
        return 'typeName';
      case 'comment':
        return 'comment';
      case 'operator':
        return 'operator';
      case 'punctuation':
        return 'punctuation';
      default:
        return 'variableName';
    }
  },
  languageData: { commentTokens: { line: '//' } },
});

const aqlHighlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--accent)' },
  { tag: t.number, color: 'var(--accent-2)' },
  { tag: t.string, color: 'var(--node-5)' },
  { tag: t.typeName, color: 'var(--node-3)' },
  { tag: t.special(t.variableName), color: 'var(--node-6)' },
  { tag: t.comment, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: t.operator, color: 'var(--text)' },
]);

/** The full AQL language extension (tokenizer + theme-aware highlighting). */
export function aql(): LanguageSupport {
  return new LanguageSupport(aqlStreamLanguage, [syntaxHighlighting(aqlHighlight)]);
}
```

- [ ] **Step 5: Run the tokenizer test to verify it passes**

Run: `pnpm -F web exec ng test --watch=false`
Expected: PASS — keyword list, case-insensitive keywords, strings/numbers/params/labels/operators, comment, and unterminated-string tolerance.

- [ ] **Step 6: Write the failing editor smoke test**

`apps/web/src/app/workspace/aql-editor.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { AqlEditor } from './aql-editor';

describe('AqlEditor component', () => {
  it('mounts a CodeMirror editor, reflects [value], and emits valueChange', async () => {
    const fixture = TestBed.createComponent(AqlEditor);
    fixture.componentRef.setInput('value', 'MATCH (n) RETURN n');
    fixture.detectChanges();
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.cm-editor')).toBeTruthy();
    expect(host.textContent).toContain('MATCH');

    const changes: string[] = [];
    fixture.componentInstance.valueChange.subscribe((v) => changes.push(v));
    fixture.componentInstance.setDoc('MATCH (p:Person) RETURN p');
    expect(changes.at(-1)).toBe('MATCH (p:Person) RETURN p');
  });

  it('invokes (run) on Ctrl/Cmd+Enter with the current document', async () => {
    const fixture = TestBed.createComponent(AqlEditor);
    fixture.componentRef.setInput('value', 'RETURN 1');
    fixture.detectChanges();
    await fixture.whenStable();
    const ran = vi.fn();
    fixture.componentInstance.run.subscribe(ran);
    fixture.componentInstance.triggerRun();
    expect(ran).toHaveBeenCalledWith('RETURN 1');
  });
});
```

- [ ] **Step 7: Run the editor test to verify it fails**

Run: `pnpm -F web exec ng test --watch=false`
Expected: FAIL — `./aql-editor` not found.

- [ ] **Step 8: Implement `apps/web/src/app/workspace/aql-editor.ts`**

The wrapper takes `value` (signal input), emits `valueChange` on every doc edit and `run(text)` on ⌘/Ctrl+Enter. It exposes `setDoc()` and `triggerRun()` for tests and for the History tab's "re-run" (Task 5). `completionSource` (Task 2) is an optional input wired later.

```ts
import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  inject,
  input,
  OnDestroy,
  Output,
  ViewChild,
} from '@angular/core';
import { autocompletion, type CompletionSource } from '@codemirror/autocomplete';
import { defaultKeymap, history as cmHistory, historyKeymap } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { aql } from './aql-language';

@Component({
  selector: 'app-aql-editor',
  template: `<div #host class="aql-editor-host"></div>`,
})
export class AqlEditor implements AfterViewInit, OnDestroy {
  readonly value = input<string>('');
  /** Optional schema-aware completion source (Task 2). */
  readonly completionSource = input<CompletionSource | null>(null);

  @Output() readonly valueChange = new EventEmitter<string>();
  @Output() readonly run = new EventEmitter<string>();

  @ViewChild('host', { static: true }) private readonly host!: ElementRef<HTMLDivElement>;
  private view: EditorView | null = null;

  ngAfterViewInit(): void {
    const source = this.completionSource();
    this.view = new EditorView({
      parent: this.host.nativeElement,
      state: EditorState.create({
        doc: this.value(),
        extensions: [
          lineNumbers(),
          cmHistory(),
          aql(),
          ...(source ? [autocompletion({ override: [source] })] : [autocompletion()]),
          keymap.of([
            {
              key: 'Mod-Enter',
              run: () => {
                this.triggerRun();
                return true;
              },
            },
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) this.valueChange.emit(u.state.doc.toString());
          }),
        ],
      }),
    });
  }

  /** Current document text. */
  doc(): string {
    return this.view?.state.doc.toString() ?? this.value();
  }

  /** Replace the whole document (used by History re-run). Emits valueChange. */
  setDoc(text: string): void {
    if (!this.view) return;
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } });
    this.valueChange.emit(text);
  }

  /** Emit run() with the current doc — bound to Mod-Enter and callable from tests. */
  triggerRun(): void {
    this.run.emit(this.doc());
  }

  ngOnDestroy(): void {
    this.view?.destroy();
  }
}
```

Note: `keymap` binding `Mod-Enter` covers both Ctrl+Enter (Windows/Linux) and Cmd+Enter (macOS) — CodeMirror's `Mod` maps to the platform meta key. `triggerRun()` reads from the live `EditorView` when mounted, falling back to the `value` input under jsdom if the view's doc has not been touched.

- [ ] **Step 9: Run both tests to verify they pass**

Run: `pnpm -F web exec ng test --watch=false`
Expected: PASS — the editor mounts a `.cm-editor`, reflects `value`, emits `valueChange` via `setDoc`, and emits `run('RETURN 1')` via `triggerRun`. (jsdom renders CodeMirror's DOM; layout-dependent behaviors are not asserted.)

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(web): AQL CodeMirror language layer and editor wrapper"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 2: Schema-aware autocomplete

A pure completion-source factory that, given the live `SchemaSummary`, offers labels (`:Label`), edge types (`[:TYPE]` and bare `TYPE`), property names (`.prop`), AQL keywords, `algo.*` procedure names, and aggregate functions — context-sensitive on the token before the cursor. Unit-tested against a `SchemaSummary` fixture; wired into the editor as the `completionSource` input.

**Files:**
- Create: `apps/web/src/app/workspace/aql-completions.ts`
- Modify: `apps/web/src/app/workspace/aql-editor.ts` (already accepts the input — no change needed)
- Test: `apps/web/src/app/workspace/aql-completions.spec.ts`

- [ ] **Step 1: Write the failing test**

`apps/web/src/app/workspace/aql-completions.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeCompletions, makeAqlCompletionSource } from './aql-completions';
import type { SchemaSummary } from '@atlas/client';

const schema: SchemaSummary = {
  labels: [
    { label: 'Person', count: 3, properties: [{ property: 'name', types: { string: 3 } }, { property: 'born', types: { number: 3 } }] },
    { label: 'Concept', count: 2, properties: [{ property: 'title', types: { string: 2 } }] },
  ],
  edgeTypes: [
    { type: 'WROTE', count: 4, from: { Person: 4 }, to: { Concept: 4 } },
    { type: 'KNOWS', count: 1, from: { Person: 1 }, to: { Person: 1 } },
  ],
};

function labels(text: string): string[] {
  return computeCompletions(schema, text, text.length).map((c) => c.label);
}

describe('computeCompletions', () => {
  it('after a colon, offers labels prefixed with :', () => {
    const got = labels('MATCH (p:');
    expect(got).toContain(':Person');
    expect(got).toContain(':Concept');
  });

  it('after a [: offers edge types', () => {
    expect(labels('MATCH (p)-[:')).toEqual(expect.arrayContaining([':WROTE', ':KNOWS']));
  });

  it('after identifier-dot offers property names', () => {
    const got = labels('MATCH (p:Person) WHERE p.');
    expect(got).toContain('name');
    expect(got).toContain('born');
  });

  it('after CALL offers algo.* procedures', () => {
    const got = labels('CALL algo.');
    expect(got).toEqual(expect.arrayContaining(['algo.pagerank', 'algo.louvain', 'algo.shortestPath']));
  });

  it('at a bare word boundary offers keywords (and filters by prefix)', () => {
    expect(labels('MAT')).toContain('MATCH');
    expect(labels('RET')).toContain('RETURN');
    expect(labels('RET')).not.toContain('MATCH');
  });

  it('makeAqlCompletionSource returns a CodeMirror CompletionSource shape', () => {
    const src = makeAqlCompletionSource(() => schema);
    expect(typeof src).toBe('function');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -F web exec ng test --watch=false`
Expected: FAIL — `./aql-completions` not found.

- [ ] **Step 3: Implement `apps/web/src/app/workspace/aql-completions.ts`**

```ts
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import type { SchemaSummary } from '@atlas/client';
import { AQL_FUNCTIONS, AQL_KEYWORDS } from './aql-language';

/** §5.2 algorithm procedures offered after `CALL` / `algo.`. */
export const ALGO_PROCEDURES: readonly string[] = [
  'algo.shortestPath', 'algo.allShortestPaths', 'algo.pagerank', 'algo.louvain',
  'algo.components', 'algo.degree', 'algo.betweenness', 'algo.bfs', 'algo.dfs',
  'algo.topoSort', 'algo.cycles',
];

export interface AqlCompletion {
  label: string;
  type: 'label' | 'edge' | 'property' | 'keyword' | 'function' | 'procedure';
  /** Replacement text (defaults to label). */
  apply?: string;
}

/** All distinct property names across the schema (autocomplete after `ident.`). */
function allProperties(schema: SchemaSummary): string[] {
  const set = new Set<string>();
  for (const l of schema.labels) for (const p of l.properties) set.add(p.property);
  return [...set].sort();
}

/**
 * Pure completion engine: given the schema, the full source, and the cursor
 * offset, return context-appropriate completions. Exported for unit tests; the
 * CodeMirror source adapter (below) calls this.
 */
export function computeCompletions(schema: SchemaSummary, source: string, cursor: number): AqlCompletion[] {
  const before = source.slice(0, cursor);

  // `[:` or `[: PARTIAL` → edge types.
  const edgeMatch = /\[:([A-Za-z0-9_]*)$/.exec(before);
  if (edgeMatch) {
    const prefix = edgeMatch[1]!.toUpperCase();
    return schema.edgeTypes
      .filter((e) => e.type.toUpperCase().startsWith(prefix))
      .map((e) => ({ label: `:${e.type}`, type: 'edge' as const, apply: `:${e.type}` }));
  }

  // `:` or `:PARTIAL` (not preceded by `[`) → labels.
  const labelMatch = /(?<!\[):([A-Za-z0-9_]*)$/.exec(before);
  if (labelMatch) {
    const prefix = labelMatch[1]!.toLowerCase();
    return schema.labels
      .filter((l) => l.label.toLowerCase().startsWith(prefix))
      .map((l) => ({ label: `:${l.label}`, type: 'label' as const, apply: `:${l.label}` }));
  }

  // `algo.PARTIAL` → procedures.
  const algoMatch = /algo\.([A-Za-z]*)$/.exec(before);
  if (algoMatch) {
    const prefix = algoMatch[1]!.toLowerCase();
    return ALGO_PROCEDURES.filter((p) => p.slice('algo.'.length).toLowerCase().startsWith(prefix)).map((p) => ({
      label: p,
      type: 'procedure' as const,
      apply: p,
    }));
  }

  // `ident.PARTIAL` → property names.
  const propMatch = /[A-Za-z_][A-Za-z0-9_]*\.([A-Za-z0-9_]*)$/.exec(before);
  if (propMatch) {
    const prefix = propMatch[1]!.toLowerCase();
    return allProperties(schema)
      .filter((p) => p.toLowerCase().startsWith(prefix))
      .map((p) => ({ label: p, type: 'property' as const }));
  }

  // Bare word → keywords + functions, filtered by the current word prefix.
  const wordMatch = /([A-Za-z]+)$/.exec(before);
  const prefix = (wordMatch?.[1] ?? '').toLowerCase();
  const out: AqlCompletion[] = [];
  for (const k of AQL_KEYWORDS)
    if (k.toLowerCase().startsWith(prefix)) out.push({ label: k, type: 'keyword' });
  for (const f of AQL_FUNCTIONS)
    if (f.toLowerCase().startsWith(prefix)) out.push({ label: f, type: 'function' });
  return out;
}

/** Adapt the pure engine to a CodeMirror CompletionSource backed by a live-schema getter. */
export function makeAqlCompletionSource(getSchema: () => SchemaSummary | null): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    const schema = getSchema();
    if (!schema) return null;
    const items = computeCompletions(schema, ctx.state.doc.toString(), ctx.pos);
    if (items.length === 0) return null;
    // Where does the replaced token start? Match the trailing token CodeMirror sees.
    const word = ctx.matchBefore(/[:.\[A-Za-z0-9_]*$/);
    const from = word ? word.from : ctx.pos;
    const options: Completion[] = items.map((c) => ({ label: c.label, type: cmType(c.type), apply: c.apply }));
    return { from, options, validFor: /[:.\[A-Za-z0-9_]*$/ };
  };
}

function cmType(type: AqlCompletion['type']): string {
  switch (type) {
    case 'label':
      return 'class';
    case 'edge':
      return 'type';
    case 'property':
      return 'property';
    case 'procedure':
      return 'function';
    case 'function':
      return 'function';
    case 'keyword':
      return 'keyword';
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -F web exec ng test --watch=false`
Expected: PASS — label/edge/property/procedure/keyword contexts, prefix filtering, and the source-shape assertion.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): schema-aware AQL autocomplete completion source"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 3: Query execution + Results table tab (+ console host + error squiggles)

The console store runs a query through `AtlasApi`/`Database.query`, holds `columns`/`rows`/`stats`/`error` as signals, and maps a thrown `AtlasClientError` whose `problem` carries `{ code, line, column, snippet }` into a structured `ConsoleError`. The Results table renders cells via a pure `cell-format` module that also detects node/edge cells (used in Task 6 for projection). The console host mounts the editor, a tab bar, and the active tab.

**Files:**
- Create: `apps/web/src/app/workspace/console.store.ts`, `apps/web/src/app/workspace/cell-format.ts`, `apps/web/src/app/workspace/results-table.ts`, `apps/web/src/app/workspace/results-table.html`, `apps/web/src/app/workspace/console.ts`, `apps/web/src/app/workspace/console.html`
- Test: `apps/web/src/app/workspace/console.store.spec.ts`, `apps/web/src/app/workspace/cell-format.spec.ts`, `apps/web/src/app/workspace/console.spec.ts`

- [ ] **Step 1: Write the failing cell-format test**

`apps/web/src/app/workspace/cell-format.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatCell, isNodeCell, isEdgeCell, extractGraphElements } from './cell-format';

describe('cell detection', () => {
  it('detects a node cell ({ id, labels, props })', () => {
    expect(isNodeCell({ id: 1, labels: ['Person'], props: { name: 'Ada' } })).toBe(true);
    expect(isNodeCell({ id: 1, type: 'KNOWS', from: 1, to: 2, props: {} })).toBe(false);
    expect(isNodeCell('Ada')).toBe(false);
    expect(isNodeCell(42)).toBe(false);
  });

  it('detects an edge cell ({ id, type, from, to, props })', () => {
    expect(isEdgeCell({ id: 5, type: 'KNOWS', from: 1, to: 2, props: {} })).toBe(true);
    expect(isEdgeCell({ id: 1, labels: ['Person'], props: {} })).toBe(false);
  });
});

describe('formatCell', () => {
  it('renders primitives, nulls, and arrays', () => {
    expect(formatCell('Ada')).toBe('Ada');
    expect(formatCell(1815)).toBe('1815');
    expect(formatCell(null)).toBe('∅');
    expect(formatCell(true)).toBe('true');
    expect(formatCell([1, 2, 3])).toBe('[1, 2, 3]');
  });

  it('renders a node as :Label {name…} and an edge as -[:TYPE]->', () => {
    expect(formatCell({ id: 1, labels: ['Person'], props: { name: 'Ada' } })).toBe(':Person {name: Ada}');
    expect(formatCell({ id: 5, type: 'KNOWS', from: 1, to: 2, props: {} })).toBe('-[:KNOWS]->');
  });
});

describe('extractGraphElements', () => {
  it('collects nodes and edges from a result, de-duplicating by id', () => {
    const columns = ['p', 'r', 'q'];
    const rows = [
      [
        { id: 1, labels: ['Person'], props: { name: 'Ada' } },
        { id: 5, type: 'KNOWS', from: 1, to: 2, props: {} },
        { id: 2, labels: ['Person'], props: { name: 'Bob' } },
      ],
      [{ id: 1, labels: ['Person'], props: { name: 'Ada' } }, null, { id: 2, labels: ['Person'], props: {} }],
    ];
    const g = extractGraphElements(columns, rows);
    expect(g.nodes.map((n) => n.id).sort()).toEqual([1, 2]);
    expect(g.edges.map((e) => e.id)).toEqual([5]);
    expect(g.hasGraph).toBe(true);
  });

  it('reports hasGraph=false for a scalar-only result', () => {
    expect(extractGraphElements(['name'], [['Ada'], ['Bob']]).hasGraph).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -F web exec ng test --watch=false`
Expected: FAIL — `./cell-format` not found.

- [ ] **Step 3: Implement `apps/web/src/app/workspace/cell-format.ts`**

```ts
/** A query-result node cell (a serialized NodeRecord — verified wire shape uses `props`). */
export interface GraphNode {
  id: number;
  labels: string[];
  props: Record<string, unknown>;
}

/** A query-result edge cell (a serialized EdgeRecord). */
export interface GraphEdge {
  id: number;
  type: string;
  from: number;
  to: number;
  props: Record<string, unknown>;
}

export function isNodeCell(v: unknown): v is GraphNode {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as GraphNode).id === 'number' &&
    Array.isArray((v as GraphNode).labels)
  );
}

export function isEdgeCell(v: unknown): v is GraphEdge {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as GraphEdge).id === 'number' &&
    typeof (v as GraphEdge).type === 'string' &&
    typeof (v as GraphEdge).from === 'number' &&
    typeof (v as GraphEdge).to === 'number'
  );
}

/** Compact human-readable cell text for the results table. */
export function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (isNodeCell(v)) {
    const label = v.labels[0] ? `:${v.labels[0]}` : '';
    const name = v.props['name'] ?? v.props['title'] ?? v.props['id'];
    return name === undefined ? `${label} {…}`.trim() : `${label} {name: ${String(name)}}`.trim();
  }
  if (isEdgeCell(v)) return `-[:${v.type}]->`;
  if (Array.isArray(v)) return `[${v.map(formatCell).join(', ')}]`;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export interface ExtractedGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  hasGraph: boolean;
}

/** Scan every cell, collecting distinct nodes/edges (by id). Powers canvas projection (Task 6). */
export function extractGraphElements(columns: string[], rows: unknown[][]): ExtractedGraph {
  const nodes = new Map<number, GraphNode>();
  const edges = new Map<number, GraphEdge>();
  for (const row of rows)
    for (const cell of row) {
      if (isNodeCell(cell)) nodes.set(cell.id, cell);
      else if (isEdgeCell(cell)) edges.set(cell.id, cell);
    }
  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    hasGraph: nodes.size > 0 || edges.size > 0,
  };
}
```

- [ ] **Step 4: Write the failing console-store test**

`apps/web/src/app/workspace/console.store.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { ConsoleStore } from './console.store';
import type { QueryResponse } from '@atlas/protocol';

const okResult: QueryResponse = {
  columns: ['name'],
  rows: [['Ada'], ['Bob']],
  stats: { rowsExamined: 2, elapsedMs: 3 },
};

function withDb(query: ReturnType<typeof vi.fn>): ConsoleStore {
  const database = vi.fn().mockReturnValue({ query });
  TestBed.configureTestingModule({ providers: [{ provide: AtlasApi, useValue: { database } }] });
  const store = TestBed.inject(ConsoleStore);
  store.useDatabase('kb');
  return store;
}

describe('ConsoleStore', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('run() populates columns/rows/stats and clears error + running', async () => {
    const query = vi.fn().mockResolvedValue(okResult);
    const store = withDb(query);
    await store.run('MATCH (p:Person) RETURN p.name AS name');
    expect(query).toHaveBeenCalledWith('MATCH (p:Person) RETURN p.name AS name', {});
    expect(store.columns()).toEqual(['name']);
    expect(store.rows()).toEqual([['Ada'], ['Bob']]);
    expect(store.stats()?.rowsExamined).toBe(2);
    expect(store.error()).toBeNull();
    expect(store.running()).toBe(false);
  });

  it('maps an AqlError problem into a structured ConsoleError with caret position', async () => {
    const err = Object.assign(new Error('unexpected token'), {
      status: 400,
      code: 'PARSE_ERROR',
      problem: { code: 'PARSE_ERROR', line: 1, column: 7, snippet: 'MATCH x\n      ^', detail: 'unexpected token' },
    });
    const store = withDb(vi.fn().mockRejectedValue(err));
    await store.run('MATCH x');
    expect(store.error()).toMatchObject({ code: 'PARSE_ERROR', line: 1, column: 7, message: 'unexpected token' });
    expect(store.error()?.snippet).toContain('^');
    expect(store.rows()).toEqual([]);
  });

  it('falls back to a generic message when the error has no problem-details', async () => {
    const store = withDb(vi.fn().mockRejectedValue(new Error('network down')));
    await store.run('RETURN 1');
    expect(store.error()?.message).toContain('network down');
    expect(store.error()?.line).toBeUndefined();
  });

  it('refuses to run an empty query', async () => {
    const query = vi.fn();
    const store = withDb(query);
    await store.run('   ');
    expect(query).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm -F web exec ng test --watch=false`
Expected: FAIL — `./console.store` not found.

- [ ] **Step 6: Implement `apps/web/src/app/workspace/console.store.ts`**

The store also holds the active tab and the schema (loaded once per database, fed to autocomplete in Task 2's source). Canvas projection (Task 6) extends `run()`; the projection call is added there.

```ts
import { computed, inject, Injectable, signal } from '@angular/core';
import type { SchemaSummary } from '@atlas/client';
import type { QueryResponse } from '@atlas/protocol';
import { AtlasApi } from '../core/atlas-api';

export type ConsoleTab = 'results' | 'plan' | 'history';

export interface ConsoleError {
  code: string;
  message: string;
  line?: number;
  column?: number;
  snippet?: string;
}

interface ClientErrorLike {
  message: string;
  code?: string;
  problem?: { code?: string; detail?: string; line?: number; column?: number; snippet?: string };
}

@Injectable({ providedIn: 'root' })
export class ConsoleStore {
  private readonly api = inject(AtlasApi);
  private dbName = '';

  private readonly _columns = signal<string[]>([]);
  private readonly _rows = signal<unknown[][]>([]);
  private readonly _stats = signal<QueryResponse['stats'] | null>(null);
  private readonly _error = signal<ConsoleError | null>(null);
  private readonly _running = signal(false);
  private readonly _tab = signal<ConsoleTab>('results');
  private readonly _schema = signal<SchemaSummary | null>(null);

  readonly columns = this._columns.asReadonly();
  readonly rows = this._rows.asReadonly();
  readonly stats = this._stats.asReadonly();
  readonly error = this._error.asReadonly();
  readonly running = this._running.asReadonly();
  readonly tab = this._tab.asReadonly();
  readonly schema = this._schema.asReadonly();
  readonly hasResults = computed(() => this._columns().length > 0);

  useDatabase(name: string): void {
    this.dbName = name;
    void this.loadSchema();
  }

  setTab(tab: ConsoleTab): void {
    this._tab.set(tab);
  }

  async loadSchema(): Promise<void> {
    try {
      this._schema.set(await this.api.database(this.dbName).schema());
    } catch {
      this._schema.set(null); // autocomplete degrades to keywords only
    }
  }

  async run(query: string, params: Record<string, unknown> = {}): Promise<QueryResponse | null> {
    const text = query.trim();
    if (!text) return null;
    this._running.set(true);
    this._error.set(null);
    try {
      const res = await this.api.database(this.dbName).query(text, params);
      this._columns.set(res.columns);
      this._rows.set(res.rows);
      this._stats.set(res.stats);
      this._tab.set('results');
      return res;
    } catch (e) {
      this._error.set(toConsoleError(e));
      this._columns.set([]);
      this._rows.set([]);
      this._stats.set(null);
      return null;
    } finally {
      this._running.set(false);
    }
  }
}

function toConsoleError(e: unknown): ConsoleError {
  const err = e as ClientErrorLike;
  const p = err.problem;
  return {
    code: p?.code ?? err.code ?? 'ERROR',
    message: p?.detail ?? err.message ?? 'Query failed.',
    line: p?.line,
    column: p?.column,
    snippet: p?.snippet,
  };
}
```

- [ ] **Step 7: Implement the Results table + console host**

`apps/web/src/app/workspace/results-table.ts`:

```ts
import { Component, input } from '@angular/core';
import { formatCell } from './cell-format';

@Component({
  selector: 'app-results-table',
  templateUrl: './results-table.html',
})
export class ResultsTable {
  readonly columns = input.required<string[]>();
  readonly rows = input.required<unknown[][]>();
  readonly fmt = formatCell;
}
```

`apps/web/src/app/workspace/results-table.html`:

```html
@if (rows().length === 0) {
  <p class="empty">No rows.</p>
} @else {
  <div class="results-scroll" role="region" aria-label="Query results">
    <table class="results-table">
      <thead>
        <tr>
          @for (col of columns(); track col) {
            <th scope="col">{{ col }}</th>
          }
        </tr>
      </thead>
      <tbody>
        @for (row of rows(); track $index) {
          <tr>
            @for (cell of row; track $index) {
              <td>{{ fmt(cell) }}</td>
            }
          </tr>
        }
      </tbody>
    </table>
  </div>
}
```

`apps/web/src/app/workspace/console.ts` (tabs wired progressively — `plan` in Task 4, `history` in Task 5; here the host renders the editor, the error banner with caret, and the Results tab):

```ts
import { Component, inject, input, viewChild } from '@angular/core';
import { makeAqlCompletionSource } from './aql-completions';
import { AqlEditor } from './aql-editor';
import { ConsoleStore } from './console.store';
import { ResultsTable } from './results-table';

@Component({
  selector: 'app-console',
  imports: [AqlEditor, ResultsTable],
  templateUrl: './console.html',
})
export class Console {
  readonly database = input.required<string>();
  readonly store = inject(ConsoleStore);
  readonly completionSource = makeAqlCompletionSource(() => this.store.schema());
  private readonly editor = viewChild(AqlEditor);

  ngOnInit(): void {
    this.store.useDatabase(this.database());
  }

  run(text: string): void {
    void this.store.run(text);
  }
}
```

`apps/web/src/app/workspace/console.html`:

```html
<section class="console" aria-label="AQL console">
  <app-aql-editor
    [value]="'MATCH (n) RETURN n LIMIT 25'"
    [completionSource]="completionSource"
    (run)="run($event)"
  />

  @if (store.error(); as err) {
    <div class="console-error" role="alert">
      <strong>{{ err.code }}</strong>
      @if (err.line) {
        <span class="caret">line {{ err.line }}:{{ err.column }}</span>
      }
      <p>{{ err.message }}</p>
      @if (err.snippet) {
        <pre class="snippet">{{ err.snippet }}</pre>
      }
    </div>
  }

  <nav class="tab-bar" role="tablist" aria-label="Console tabs">
    <button role="tab" [attr.aria-selected]="store.tab() === 'results'" (click)="store.setTab('results')">Results</button>
    <button role="tab" [attr.aria-selected]="store.tab() === 'plan'" (click)="store.setTab('plan')">EXPLAIN Plan</button>
    <button role="tab" [attr.aria-selected]="store.tab() === 'history'" (click)="store.setTab('history')">History</button>
  </nav>

  <div class="tab-panel" role="tabpanel">
    @switch (store.tab()) {
      @case ('results') {
        @if (store.stats(); as s) {
          <p class="stats">{{ store.rows().length }} rows · {{ s.elapsedMs }} ms</p>
        }
        <app-results-table [columns]="store.columns()" [rows]="store.rows()" />
      }
      @default {
        <p class="empty">Tab arrives in a later task.</p>
      }
    }
  </div>
</section>
```

The squiggle: the structured `ConsoleError` carries `line`/`column`/`snippet`; the editor wrapper exposes an optional `setError(line, column)` decoration in a follow-up — for v1 the error is shown as a banner with the caret snippet (the spec's "error message with caret position"), and the inline squiggle is added by extending `AqlEditor` with a CodeMirror `Decoration.mark` over the offending column range. Add that decoration only if it can be unit-asserted via the banner; the banner + snippet is the asserted surface here. (Inline squiggle decoration noted as a deliberate v1 boundary in the self-review.)

- [ ] **Step 8: Write the console-host smoke test**

`apps/web/src/app/workspace/console.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { Console } from './console';

describe('Console host', () => {
  it('runs the editor query through the store and shows the results table', async () => {
    const query = vi.fn().mockResolvedValue({ columns: ['name'], rows: [['Ada']], stats: { rowsExamined: 1, elapsedMs: 1 } });
    const schema = vi.fn().mockResolvedValue({ labels: [], edgeTypes: [] });
    await TestBed.configureTestingModule({
      imports: [Console],
      providers: [{ provide: AtlasApi, useValue: { database: () => ({ query, schema }) } }],
    }).compileComponents();
    const fixture = TestBed.createComponent(Console);
    fixture.componentRef.setInput('database', 'kb');
    fixture.detectChanges();
    await fixture.whenStable();

    await fixture.componentInstance.store.run('MATCH (p:Person) RETURN p.name AS name');
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Ada');
  });

  it('renders the structured error banner with the caret snippet', async () => {
    const query = vi.fn().mockRejectedValue(
      Object.assign(new Error('bad'), { problem: { code: 'PARSE_ERROR', detail: 'bad token', line: 1, column: 3, snippet: 'XY\n  ^' } }),
    );
    await TestBed.configureTestingModule({
      imports: [Console],
      providers: [{ provide: AtlasApi, useValue: { database: () => ({ query, schema: vi.fn().mockResolvedValue({ labels: [], edgeTypes: [] }) }) } }],
    }).compileComponents();
    const fixture = TestBed.createComponent(Console);
    fixture.componentRef.setInput('database', 'kb');
    fixture.detectChanges();
    await fixture.componentInstance.store.run('XY');
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('PARSE_ERROR');
    expect(text).toContain('line 1:3');
  });
});
```

- [ ] **Step 9: Run all Task 3 tests to verify they pass**

Run: `pnpm -F web exec ng test --watch=false`
Expected: PASS — cell-format detection/formatting/extraction, store run/error-mapping/empty-guard, and the console host smoke (results render, error banner with caret).

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(web): AQL console store, results table, and structured query errors"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 4: EXPLAIN Plan tab

Run `EXPLAIN <query>` through the store, take the returned single `plan` cell (the serialized `PlanNode` tree), and transform it into a flat, indented tree view-model with depth + child links resolved — rendered as a readable tree. The transform is a pure function unit-tested against real plan JSON shapes.

**Files:**
- Create: `apps/web/src/app/workspace/explain-plan.ts`, `apps/web/src/app/workspace/explain-plan-view.ts`, `apps/web/src/app/workspace/explain-plan-view.html`
- Modify: `apps/web/src/app/workspace/console.store.ts` (add `explain()`), `apps/web/src/app/workspace/console.ts`/`console.html` (wire the plan tab)
- Test: `apps/web/src/app/workspace/explain-plan.spec.ts`

- [ ] **Step 1: Write the failing test**

`apps/web/src/app/workspace/explain-plan.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { planToTree, type PlanTreeRow } from './explain-plan';

function labels(rows: PlanTreeRow[]): Array<[number, string]> {
  return rows.map((r) => [r.depth, r.op]);
}

describe('planToTree', () => {
  it('flattens a unary chain (child) into depth-ordered rows', () => {
    const plan = {
      op: 'Project',
      columns: ['name'],
      child: {
        op: 'Filter',
        expr: "p.born > 1800",
        child: { op: 'LabelScan', variable: 'p', label: 'Person', estCost: 3 },
      },
    };
    const rows = planToTree(plan);
    expect(labels(rows)).toEqual([
      [0, 'Project'],
      [1, 'Filter'],
      [2, 'LabelScan'],
    ]);
    expect(rows[0]!.detail).toContain('name');
    expect(rows[2]!.detail).toContain('Person');
    expect(rows[2]!.estCost).toBe(3);
  });

  it('expands binary nodes (left/right) as two children', () => {
    const plan = {
      op: 'CartesianProduct',
      left: { op: 'AllNodesScan', variable: 'a', estCost: 10 },
      right: { op: 'AllNodesScan', variable: 'b', estCost: 10 },
    };
    expect(labels(planToTree(plan))).toEqual([
      [0, 'CartesianProduct'],
      [1, 'AllNodesScan'],
      [1, 'AllNodesScan'],
    ]);
  });

  it('handles a flat write plan ({ op: Write, steps: [...] })', () => {
    const plan = { op: 'Write', steps: [{ op: 'Create', patterns: 1 }, { op: 'Project', columns: 1 }] };
    expect(labels(planToTree(plan))).toEqual([
      [0, 'Write'],
      [1, 'Create'],
      [1, 'Project'],
    ]);
  });

  it('handles a Call plan', () => {
    const plan = { op: 'Call', name: 'algo.pagerank', yields: ['node', 'score'] };
    const rows = planToTree(plan);
    expect(rows[0]!.op).toBe('Call');
    expect(rows[0]!.detail).toContain('algo.pagerank');
  });

  it('never throws on an unknown shape', () => {
    expect(() => planToTree({ op: 'Mystery', foo: 1 })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -F web exec ng test --watch=false`
Expected: FAIL — `./explain-plan` not found.

- [ ] **Step 3: Implement `apps/web/src/app/workspace/explain-plan.ts`**

```ts
export interface PlanTreeRow {
  depth: number;
  op: string;
  /** Compact one-line summary of the node's scalar fields. */
  detail: string;
  estCost?: number;
}

/** Keys that hold child plan nodes (unary `child`, binary `left`/`right`) or step arrays. */
const CHILD_KEYS = ['child', 'left', 'right'] as const;
const ARRAY_CHILD_KEYS = ['steps'] as const;

function isPlanNode(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { op?: unknown }).op === 'string';
}

/** Render the non-structural scalar fields of a plan node as `key=value` pairs. */
function detailOf(node: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(node)) {
    if (k === 'op' || k === 'estCost') continue;
    if (CHILD_KEYS.includes(k as (typeof CHILD_KEYS)[number])) continue;
    if (ARRAY_CHILD_KEYS.includes(k as (typeof ARRAY_CHILD_KEYS)[number])) continue;
    if (isPlanNode(v)) continue;
    parts.push(`${k}=${Array.isArray(v) ? `[${v.join(', ')}]` : String(v)}`);
  }
  return parts.join('  ');
}

/** Flatten a serialized plan tree into depth-ordered rows for tree rendering. Never throws. */
export function planToTree(plan: unknown, depth = 0, out: PlanTreeRow[] = []): PlanTreeRow[] {
  if (!isPlanNode(plan)) return out;
  out.push({
    depth,
    op: String(plan.op),
    detail: detailOf(plan),
    estCost: typeof plan.estCost === 'number' ? plan.estCost : undefined,
  });
  // Recurse into named child nodes.
  for (const key of CHILD_KEYS) if (isPlanNode(plan[key])) planToTree(plan[key], depth + 1, out);
  // Flat step arrays (write plans) become depth+1 leaves.
  for (const key of ARRAY_CHILD_KEYS) {
    const arr = plan[key];
    if (Array.isArray(arr))
      for (const step of arr) if (isPlanNode(step)) planToTree(step, depth + 1, out);
  }
  return out;
}
```

- [ ] **Step 4: Add `explain()` to the console store and wire the plan tab**

In `apps/web/src/app/workspace/console.store.ts`, add a plan signal and an `explain` method that prefixes the query and reads the single `plan` cell:

```ts
// add near the other signals
import { planToTree, type PlanTreeRow } from './explain-plan';
// ...
  private readonly _plan = signal<PlanTreeRow[]>([]);
  readonly plan = this._plan.asReadonly();

  async explain(query: string): Promise<void> {
    const text = query.trim();
    if (!text) return;
    this._running.set(true);
    this._error.set(null);
    try {
      const res = await this.api.database(this.dbName).query(`EXPLAIN ${text}`, {});
      const planCell = res.rows[0]?.[0];
      this._plan.set(planToTree(planCell));
      this._tab.set('plan');
    } catch (e) {
      this._error.set(toConsoleError(e));
      this._plan.set([]);
    } finally {
      this._running.set(false);
    }
  }
```

`apps/web/src/app/workspace/explain-plan-view.ts`:

```ts
import { Component, input } from '@angular/core';
import type { PlanTreeRow } from './explain-plan';

@Component({
  selector: 'app-explain-plan-view',
  templateUrl: './explain-plan-view.html',
})
export class ExplainPlanView {
  readonly rows = input.required<PlanTreeRow[]>();
  indent(depth: number): string {
    return `${depth * 1.25}rem`;
  }
}
```

`apps/web/src/app/workspace/explain-plan-view.html`:

```html
@if (rows().length === 0) {
  <p class="empty">Run EXPLAIN to see the query plan.</p>
} @else {
  <ul class="plan-tree" role="tree" aria-label="Query plan">
    @for (row of rows(); track $index) {
      <li class="plan-row" role="treeitem" [attr.aria-level]="row.depth + 1" [style.padding-left]="indent(row.depth)">
        <span class="plan-op">{{ row.op }}</span>
        @if (row.estCost !== undefined) {
          <span class="plan-cost">~{{ row.estCost }}</span>
        }
        @if (row.detail) {
          <span class="plan-detail">{{ row.detail }}</span>
        }
      </li>
    }
  </ul>
}
```

In `console.ts`, import `ExplainPlanView`, add it to `imports`, and add an `explain()` method calling `this.store.explain(this.editor()?.doc() ?? '')`. In `console.html`, add an "EXPLAIN" button next to the tab bar (`<button (click)="explain()">EXPLAIN</button>`) and render `<app-explain-plan-view [rows]="store.plan()" />` in the `@case ('plan')` branch.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm -F web exec ng test --watch=false`
Expected: PASS — unary chain depth ordering, binary expansion, write/call flat plans, unknown-shape tolerance.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): EXPLAIN Plan tab with pure plan-to-tree transform"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 5: History tab

A recent-queries store persisted to `localStorage` (per database, capped, most-recent-first, de-duplicated), re-runnable on click. Pure store logic unit-tested; the History tab lists entries and re-runs via the editor + console store.

**Files:**
- Create: `apps/web/src/app/workspace/history.store.ts`
- Modify: `apps/web/src/app/workspace/console.ts`/`console.html` (record on run; render the history tab)
- Test: `apps/web/src/app/workspace/history.store.spec.ts`

- [ ] **Step 1: Write the failing test**

`apps/web/src/app/workspace/history.store.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { HistoryStore } from './history.store';

describe('HistoryStore', () => {
  beforeEach(() => localStorage.clear());

  function make(): HistoryStore {
    return TestBed.runInInjectionContext(() => new HistoryStore());
  }

  it('records queries most-recent-first', () => {
    const h = make();
    h.use('kb');
    h.add('MATCH (a) RETURN a');
    h.add('MATCH (b) RETURN b');
    expect(h.entries().map((e) => e.query)).toEqual(['MATCH (b) RETURN b', 'MATCH (a) RETURN a']);
  });

  it('de-duplicates: re-adding an existing query moves it to the front', () => {
    const h = make();
    h.use('kb');
    h.add('Q1');
    h.add('Q2');
    h.add('Q1');
    expect(h.entries().map((e) => e.query)).toEqual(['Q1', 'Q2']);
  });

  it('ignores blank queries and trims', () => {
    const h = make();
    h.use('kb');
    h.add('   ');
    h.add('  RETURN 1  ');
    expect(h.entries().map((e) => e.query)).toEqual(['RETURN 1']);
  });

  it('caps the list at 50 entries', () => {
    const h = make();
    h.use('kb');
    for (let i = 0; i < 60; i++) h.add(`Q${i}`);
    expect(h.entries()).toHaveLength(50);
    expect(h.entries()[0]!.query).toBe('Q59');
  });

  it('persists per database and restores on a new instance', () => {
    const a = make();
    a.use('kb');
    a.add('MATCH (n) RETURN n');
    const b = make();
    b.use('kb');
    expect(b.entries().map((e) => e.query)).toEqual(['MATCH (n) RETURN n']);
    b.use('other');
    expect(b.entries()).toEqual([]);
  });

  it('clear() empties the current database history', () => {
    const h = make();
    h.use('kb');
    h.add('Q1');
    h.clear();
    expect(h.entries()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -F web exec ng test --watch=false`
Expected: FAIL — `./history.store` not found.

- [ ] **Step 3: Implement `apps/web/src/app/workspace/history.store.ts`**

```ts
import { Injectable, signal } from '@angular/core';

export interface HistoryEntry {
  query: string;
  /** Insertion counter (monotonic within the session) for stable ordering. */
  seq: number;
}

const MAX_ENTRIES = 50;
const KEY_PREFIX = 'atlas.history.';

@Injectable({ providedIn: 'root' })
export class HistoryStore {
  private dbName = '';
  private seq = 0;
  private readonly _entries = signal<HistoryEntry[]>([]);
  readonly entries = this._entries.asReadonly();

  use(dbName: string): void {
    this.dbName = dbName;
    this._entries.set(this.restore());
  }

  add(query: string): void {
    const text = query.trim();
    if (!text) return;
    const without = this._entries().filter((e) => e.query !== text);
    const next = [{ query: text, seq: ++this.seq }, ...without].slice(0, MAX_ENTRIES);
    this._entries.set(next);
    this.persist(next);
  }

  clear(): void {
    this._entries.set([]);
    this.persist([]);
  }

  private storageKey(): string {
    return `${KEY_PREFIX}${this.dbName}`;
  }

  private restore(): HistoryEntry[] {
    try {
      const raw = localStorage.getItem(this.storageKey());
      if (!raw) return [];
      const parsed = JSON.parse(raw) as HistoryEntry[];
      return Array.isArray(parsed) ? parsed.slice(0, MAX_ENTRIES) : [];
    } catch {
      return [];
    }
  }

  private persist(entries: HistoryEntry[]): void {
    try {
      localStorage.setItem(this.storageKey(), JSON.stringify(entries));
    } catch {
      // localStorage unavailable (private mode) — history stays in-memory only.
    }
  }
}
```

- [ ] **Step 4: Wire history into the console**

In `console.ts`: inject `HistoryStore`, call `history.use(this.database())` in `ngOnInit`, and in `run(text)` call `this.history.add(text)` before `this.store.run(text)`. Add `rerun(query: string)` that calls `this.editor()?.setDoc(query)` then `this.run(query)`. In `console.html`, render the history tab:

```html
@case ('history') {
  @if (history.entries().length === 0) {
    <p class="empty">No queries yet.</p>
  } @else {
    <ul class="history-list">
      @for (e of history.entries(); track e.seq) {
        <li>
          <button type="button" class="history-item" (click)="rerun(e.query)">{{ e.query }}</button>
        </li>
      }
    </ul>
    <button type="button" (click)="history.clear()">Clear history</button>
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm -F web exec ng test --watch=false`
Expected: PASS — order, de-dup, trim/blank, cap at 50, per-db persistence, clear.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): console history tab persisted to localStorage"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 6: Project results onto the canvas (the M6b workspace-store integration)

Define the narrow `WorkspaceGraphStore` interface that M6c needs from M6b, plus a pure `resultToGraph` projection (result → `{ nodes, edges }`) and an in-memory fake for tests. The console, after a successful run that contains nodes/edges, hands them to the store via `setGraph(...)`. Because M6b is concurrent and may be absent, M6c owns this contract; M6b implements it.

**Files:**
- Create: `apps/web/src/app/workspace/workspace-graph-store.contract.ts`
- Modify: `apps/web/src/app/workspace/console.store.ts` (call `setGraph` on a node-bearing result), `apps/web/src/app/workspace/console.ts`/`console.html` (a "Project to canvas" affordance)
- Test: `apps/web/src/app/workspace/workspace-graph-store.contract.spec.ts`, `apps/web/src/app/workspace/console.store.spec.ts` (add projection cases)

- [ ] **Step 1: Write the failing contract test**

`apps/web/src/app/workspace/workspace-graph-store.contract.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  resultToGraph,
  InMemoryWorkspaceGraphStore,
  type WorkspaceGraphStore,
} from './workspace-graph-store.contract';

describe('resultToGraph', () => {
  it('projects node + edge cells from a result into a graph payload', () => {
    const columns = ['p', 'r', 'q'];
    const rows = [
      [
        { id: 1, labels: ['Person'], props: { name: 'Ada' } },
        { id: 9, type: 'KNOWS', from: 1, to: 2, props: {} },
        { id: 2, labels: ['Person'], props: { name: 'Bob' } },
      ],
    ];
    const g = resultToGraph(columns, rows);
    expect(g.nodes.map((n) => n.id).sort()).toEqual([1, 2]);
    expect(g.edges).toEqual([{ id: 9, type: 'KNOWS', from: 1, to: 2, props: {} }]);
  });

  it('returns empty arrays for a scalar-only result', () => {
    expect(resultToGraph(['name'], [['Ada']])).toEqual({ nodes: [], edges: [] });
  });
});

describe('InMemoryWorkspaceGraphStore (the test fake implementing the contract)', () => {
  it('setGraph replaces the displayed graph; paintAlgorithmResult records the styling', () => {
    const store: WorkspaceGraphStore = new InMemoryWorkspaceGraphStore();
    store.setGraph({ nodes: [{ id: 1, labels: ['Person'], props: {} }], edges: [] });
    const mem = store as InMemoryWorkspaceGraphStore;
    expect(mem.nodes.map((n) => n.id)).toEqual([1]);

    store.paintAlgorithmResult({ scores: new Map([[1, 0.5]]), communities: new Map([[1, 0]]), paths: [] });
    expect(mem.lastPaint?.scores.get(1)).toBe(0.5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -F web exec ng test --watch=false`
Expected: FAIL — `./workspace-graph-store.contract` not found.

- [ ] **Step 3: Implement `apps/web/src/app/workspace/workspace-graph-store.contract.ts`**

```ts
import { InjectionToken } from '@angular/core';
import { extractGraphElements, type GraphEdge, type GraphNode } from './cell-format';

/** A graph payload the canvas can display. */
export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Algorithm output styling for the canvas (§7.2):
 * - `scores`  → node size (e.g. PageRank/degree/betweenness)
 * - `communities` → node color (Louvain/components)
 * - `paths`   → highlighted node-id sequences (shortest paths / cycles)
 */
export interface AlgorithmPaint {
  scores: Map<number, number>;
  communities: Map<number, number>;
  paths: number[][];
}

/**
 * The minimal contract M6c needs from the M6b workspace canvas store. M6b's
 * concrete store is expected to implement this interface (or an M6d adapter
 * bridges them). Consumers depend on WORKSPACE_GRAPH_STORE (DI token), never
 * on a concrete class — so M6c is buildable/testable before M6b lands.
 */
export interface WorkspaceGraphStore {
  /** Replace the displayed node/edge set (e.g. console "project to canvas"). */
  setGraph(payload: GraphPayload): void;
  /** Apply algorithm styling to the currently displayed graph. */
  paintAlgorithmResult(paint: AlgorithmPaint): void;
}

export const WORKSPACE_GRAPH_STORE = new InjectionToken<WorkspaceGraphStore>('WorkspaceGraphStore');

/** Pure projection: pull distinct node/edge cells out of a query result. */
export function resultToGraph(columns: string[], rows: unknown[][]): GraphPayload {
  const { nodes, edges } = extractGraphElements(columns, rows);
  return { nodes, edges };
}

/**
 * An in-memory implementation used by M6c tests and as the default provider
 * until M6b provides the canvas-backed store. Records the last paint for assertions.
 */
export class InMemoryWorkspaceGraphStore implements WorkspaceGraphStore {
  nodes: GraphNode[] = [];
  edges: GraphEdge[] = [];
  lastPaint: AlgorithmPaint | null = null;

  setGraph(payload: GraphPayload): void {
    this.nodes = payload.nodes;
    this.edges = payload.edges;
  }

  paintAlgorithmResult(paint: AlgorithmPaint): void {
    this.lastPaint = paint;
  }
}
```

Provide the fake as the default `WORKSPACE_GRAPH_STORE` in `apps/web/src/app/app.config.ts` so the app runs standalone today:

```ts
// in app.config.ts providers:
import { WORKSPACE_GRAPH_STORE, InMemoryWorkspaceGraphStore } from './workspace/workspace-graph-store.contract';
// ...
{ provide: WORKSPACE_GRAPH_STORE, useClass: InMemoryWorkspaceGraphStore },
```

When M6b lands, it overrides this token with its canvas-backed store (boundary noted in the self-review).

- [ ] **Step 4: Wire projection into the console store**

In `console.store.ts`, inject the token (optional so the store works in unit tests without a provider) and project node-bearing results:

```ts
import { inject as ngInject } from '@angular/core'; // already importing inject
import { resultToGraph, WORKSPACE_GRAPH_STORE } from './workspace-graph-store.contract';
// ...
  private readonly graphStore = inject(WORKSPACE_GRAPH_STORE, { optional: true });
  private readonly _projectable = signal(false);
  readonly projectable = this._projectable.asReadonly();
```

In `run(...)`, after setting columns/rows, compute projectability and (optionally) auto-project — but make projection explicit via a method so tests assert it deterministically:

```ts
      this._columns.set(res.columns);
      this._rows.set(res.rows);
      this._projectable.set(resultToGraph(res.columns, res.rows).nodes.length > 0);
```

Add:

```ts
  /** Hand the current result's nodes/edges to the canvas store (console "project to canvas"). */
  projectToCanvas(): void {
    const graph = resultToGraph(this._columns(), this._rows());
    if (graph.nodes.length > 0) this.graphStore?.setGraph(graph);
  }
```

- [ ] **Step 5: Add projection cases to `console.store.spec.ts`**

Append:

```ts
import { WORKSPACE_GRAPH_STORE, InMemoryWorkspaceGraphStore } from './workspace-graph-store.contract';

it('marks a node-bearing result as projectable and projects it to the canvas store', async () => {
  const nodeResult = {
    columns: ['p'],
    rows: [[{ id: 1, labels: ['Person'], props: { name: 'Ada' } }]],
    stats: { rowsExamined: 1, elapsedMs: 1 },
  };
  const database = vi.fn().mockReturnValue({ query: vi.fn().mockResolvedValue(nodeResult) });
  const fake = new InMemoryWorkspaceGraphStore();
  TestBed.configureTestingModule({
    providers: [
      { provide: AtlasApi, useValue: { database } },
      { provide: WORKSPACE_GRAPH_STORE, useValue: fake },
    ],
  });
  const store = TestBed.inject(ConsoleStore);
  store.useDatabase('kb');
  await store.run('MATCH (p:Person) RETURN p');
  expect(store.projectable()).toBe(true);
  store.projectToCanvas();
  expect(fake.nodes.map((n) => n.id)).toEqual([1]);
});

it('scalar results are not projectable', async () => {
  const store = withDb(vi.fn().mockResolvedValue(okResult));
  await store.run('MATCH (p) RETURN p.name AS name');
  expect(store.projectable()).toBe(false);
});
```

In `console.html`, add a "Project to canvas" button shown only when projectable:

```html
@if (store.projectable()) {
  <button type="button" class="project-btn" (click)="store.projectToCanvas()">Project to canvas</button>
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm -F web exec ng test --watch=false`
Expected: PASS — `resultToGraph` projection, the in-memory store contract, console-store projectability + projection, and the existing Task 3 cases still green.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): workspace graph-store contract and console result projection"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 7: Schema view

Fetch `Database.schema()` and render an auto-generated diagram: one box per label (with count) and one connector per edge type (from→to label). A pure layout transform turns the `SchemaSummary` into a positioned view-model (label boxes on a ring/grid, edge connectors with endpoints resolved by dominant from/to label); the view renders it as SVG.

**Files:**
- Create: `apps/web/src/app/workspace/schema-diagram.ts`, `apps/web/src/app/workspace/schema-view.ts`, `apps/web/src/app/workspace/schema-view.html`
- Modify: `apps/web/src/app/app.routes.ts`
- Test: `apps/web/src/app/workspace/schema-diagram.spec.ts`

- [ ] **Step 1: Write the failing test**

`apps/web/src/app/workspace/schema-diagram.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildSchemaDiagram } from './schema-diagram';
import type { SchemaSummary } from '@atlas/client';

const schema: SchemaSummary = {
  labels: [
    { label: 'Person', count: 3, properties: [{ property: 'name', types: { string: 3 } }] },
    { label: 'Concept', count: 2, properties: [] },
  ],
  edgeTypes: [
    { type: 'WROTE', count: 4, from: { Person: 4 }, to: { Concept: 4 } },
    { type: 'KNOWS', count: 1, from: { Person: 1 }, to: { Person: 1 } },
  ],
};

describe('buildSchemaDiagram', () => {
  it('produces one node per label with its count, positioned within the viewport', () => {
    const d = buildSchemaDiagram(schema, { width: 800, height: 600 });
    expect(d.nodes.map((n) => n.label).sort()).toEqual(['Concept', 'Person']);
    const person = d.nodes.find((n) => n.label === 'Person')!;
    expect(person.count).toBe(3);
    expect(person.x).toBeGreaterThanOrEqual(0);
    expect(person.x).toBeLessThanOrEqual(800);
    expect(person.y).toBeGreaterThanOrEqual(0);
    expect(person.y).toBeLessThanOrEqual(600);
  });

  it('resolves each edge type to its dominant from/to label endpoints', () => {
    const d = buildSchemaDiagram(schema, { width: 800, height: 600 });
    const wrote = d.edges.find((e) => e.type === 'WROTE')!;
    expect(wrote.fromLabel).toBe('Person');
    expect(wrote.toLabel).toBe('Concept');
    expect(wrote.count).toBe(4);
    expect(wrote.fromX).toEqual(d.nodes.find((n) => n.label === 'Person')!.x);
  });

  it('marks a self-referential edge type (from === to)', () => {
    const d = buildSchemaDiagram(schema, { width: 800, height: 600 });
    expect(d.edges.find((e) => e.type === 'KNOWS')!.selfLoop).toBe(true);
  });

  it('handles an empty schema without throwing', () => {
    expect(buildSchemaDiagram({ labels: [], edgeTypes: [] }, { width: 100, height: 100 })).toEqual({
      nodes: [],
      edges: [],
    });
  });

  it('drops an edge whose endpoints are not present as labels', () => {
    const orphan: SchemaSummary = {
      labels: [{ label: 'Person', count: 1, properties: [] }],
      edgeTypes: [{ type: 'GHOST', count: 1, from: { Ghost: 1 }, to: { Person: 1 } }],
    };
    expect(buildSchemaDiagram(orphan, { width: 100, height: 100 }).edges).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -F web exec ng test --watch=false`
Expected: FAIL — `./schema-diagram` not found.

- [ ] **Step 3: Implement `apps/web/src/app/workspace/schema-diagram.ts`**

```ts
import type { SchemaSummary } from '@atlas/client';

export interface SchemaDiagramNode {
  label: string;
  count: number;
  /** Distinct property names for this label (for the box body). */
  properties: string[];
  x: number;
  y: number;
}

export interface SchemaDiagramEdge {
  type: string;
  count: number;
  fromLabel: string;
  toLabel: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  selfLoop: boolean;
}

export interface SchemaDiagram {
  nodes: SchemaDiagramNode[];
  edges: SchemaDiagramEdge[];
}

export interface Viewport {
  width: number;
  height: number;
}

/** The label with the highest frequency in a from/to distribution (or null if empty). */
function dominant(dist: Record<string, number>): string | null {
  let best: string | null = null;
  let bestN = -1;
  for (const [label, n] of Object.entries(dist))
    if (n > bestN) {
      best = label;
      bestN = n;
    }
  return best;
}

/**
 * Deterministic ring layout: label boxes evenly spaced on an ellipse inside the
 * viewport, edges connecting dominant from/to endpoints. Pure + side-effect-free
 * so it is fully unit-testable; the SVG view consumes the positioned view-model.
 */
export function buildSchemaDiagram(schema: SchemaSummary, viewport: Viewport): SchemaDiagram {
  const { width, height } = viewport;
  const cx = width / 2;
  const cy = height / 2;
  const rx = Math.max(width / 2 - 80, 0);
  const ry = Math.max(height / 2 - 60, 0);
  const n = schema.labels.length;

  const nodes: SchemaDiagramNode[] = schema.labels.map((l, i) => {
    const angle = n === 0 ? 0 : (2 * Math.PI * i) / n - Math.PI / 2;
    return {
      label: l.label,
      count: l.count,
      properties: l.properties.map((p) => p.property),
      x: n === 1 ? cx : cx + rx * Math.cos(angle),
      y: n === 1 ? cy : cy + ry * Math.sin(angle),
    };
  });

  const byLabel = new Map(nodes.map((node) => [node.label, node]));

  const edges: SchemaDiagramEdge[] = [];
  for (const e of schema.edgeTypes) {
    const fromLabel = dominant(e.from);
    const toLabel = dominant(e.to);
    if (!fromLabel || !toLabel) continue;
    const a = byLabel.get(fromLabel);
    const b = byLabel.get(toLabel);
    if (!a || !b) continue; // endpoint label not in the schema → drop
    edges.push({
      type: e.type,
      count: e.count,
      fromLabel,
      toLabel,
      fromX: a.x,
      fromY: a.y,
      toX: b.x,
      toY: b.y,
      selfLoop: fromLabel === toLabel,
    });
  }

  return { nodes, edges };
}
```

- [ ] **Step 4: Implement the Schema view component**

`apps/web/src/app/workspace/schema-view.ts`:

```ts
import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { AtlasApi } from '../core/atlas-api';
import { buildSchemaDiagram, type SchemaDiagram } from './schema-diagram';

@Component({
  selector: 'app-schema-view',
  templateUrl: './schema-view.html',
})
export class SchemaView {
  private readonly api = inject(AtlasApi);
  private readonly route = inject(ActivatedRoute);
  readonly diagram = signal<SchemaDiagram>({ nodes: [], edges: [] });
  readonly loading = signal(true);
  readonly error = signal('');

  async ngOnInit(): Promise<void> {
    const name = this.route.snapshot.paramMap.get('name') ?? '';
    try {
      const schema = await this.api.database(name).schema();
      this.diagram.set(buildSchemaDiagram(schema, { width: 900, height: 600 }));
    } catch {
      this.error.set('Could not load the schema.');
    } finally {
      this.loading.set(false);
    }
  }
}
```

`apps/web/src/app/workspace/schema-view.html`:

```html
<section class="schema-view" aria-label="Schema diagram">
  <h1>Schema</h1>
  @if (loading()) {
    <p>Loading…</p>
  } @else if (error()) {
    <p class="error" role="alert">{{ error() }}</p>
  } @else if (diagram().nodes.length === 0) {
    <p class="empty">No labels yet — this database is empty.</p>
  } @else {
    <svg class="schema-svg" viewBox="0 0 900 600" role="img" aria-label="Labels and edge types">
      @for (e of diagram().edges; track e.type) {
        <g class="schema-edge">
          <line [attr.x1]="e.fromX" [attr.y1]="e.fromY" [attr.x2]="e.toX" [attr.y2]="e.toY" />
          <text [attr.x]="(e.fromX + e.toX) / 2" [attr.y]="(e.fromY + e.toY) / 2">
            {{ e.type }} ({{ e.count }})
          </text>
        </g>
      }
      @for (node of diagram().nodes; track node.label) {
        <g class="schema-node" [attr.transform]="'translate(' + node.x + ',' + node.y + ')'">
          <rect x="-60" y="-22" width="120" height="44" rx="8" />
          <text class="schema-label" text-anchor="middle" y="-2">{{ node.label }}</text>
          <text class="schema-count" text-anchor="middle" y="14">{{ node.count }} nodes</text>
        </g>
      }
    </svg>
  }
</section>
```

- [ ] **Step 5: Add the schema route**

In `apps/web/src/app/app.routes.ts`, add a child/sibling route for the schema view under the authenticated guard:

```ts
{
  path: 'db/:name/schema',
  canActivate: [authGuard],
  loadComponent: () => import('./workspace/schema-view').then((m) => m.SchemaView),
},
```

(Place it alongside the existing `db/:name` route from M6a; keep the `**` redirect last.)

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm -F web exec ng test --watch=false`
Expected: PASS — node positions in-bounds with counts, dominant-endpoint resolution, self-loop flagging, empty schema, orphan-edge drop.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): schema view with pure diagram layout transform"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 8: Algorithms view + Playwright e2e + full gate

A pure catalog of the v1 algorithm set (§4.7/§5.2) with their parameter specs, an AQL-`CALL`-builder that turns a filled form into an injection-safe `CALL algo.<name>(...) YIELD ...` string (using `$params`), and a result-paint mapper that turns YIELD rows into `AlgorithmPaint` (id→score for size, id→community for color, paths for highlight). The view renders parameter forms, runs via the console store, and paints via the M6b store contract. Then a Playwright e2e, README, and the green gate.

**Files:**
- Create: `apps/web/src/app/workspace/algorithms.ts`, `apps/web/src/app/workspace/algorithms-view.ts`, `apps/web/src/app/workspace/algorithms-view.html`, `apps/web/e2e/console.spec.ts`
- Modify: `apps/web/src/app/app.routes.ts`, `README.md`
- Test: `apps/web/src/app/workspace/algorithms.spec.ts`, `apps/web/e2e/console.spec.ts`

- [ ] **Step 1: Write the failing algorithms test**

`apps/web/src/app/workspace/algorithms.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ALGORITHMS, buildAlgorithmCall, paintFromRows, findAlgorithm } from './algorithms';

describe('ALGORITHMS catalog', () => {
  it('covers the §4.7/§5.2 v1 set', () => {
    const names = ALGORITHMS.map((a) => a.name);
    for (const n of [
      'algo.pagerank', 'algo.louvain', 'algo.components', 'algo.degree', 'algo.betweenness',
      'algo.shortestPath', 'algo.allShortestPaths', 'algo.bfs', 'algo.dfs', 'algo.topoSort', 'algo.cycles',
    ])
      expect(names).toContain(n);
  });

  it('declares params with defaults matching the spec table', () => {
    const pr = findAlgorithm('algo.pagerank')!;
    expect(pr.params.find((p) => p.key === 'damping')?.default).toBe(0.85);
    expect(pr.params.find((p) => p.key === 'iterations')?.default).toBe(20);
    expect(pr.yields).toEqual(['node', 'score']);
  });
});

describe('buildAlgorithmCall', () => {
  it('builds a parameterized CALL with YIELD, omitting blank optional params', () => {
    const built = buildAlgorithmCall(findAlgorithm('algo.pagerank')!, { damping: 0.85, iterations: 20 });
    expect(built.query).toBe('CALL algo.pagerank({damping: $damping, iterations: $iterations}) YIELD node, score RETURN node, score');
    expect(built.params).toEqual({ damping: 0.85, iterations: 20 });
  });

  it('omits unset optional params and keeps required ones', () => {
    const built = buildAlgorithmCall(findAlgorithm('algo.shortestPath')!, { from: 1, to: 2, weightProp: '' });
    expect(built.query).toContain('from: $from');
    expect(built.query).toContain('to: $to');
    expect(built.query).not.toContain('weightProp');
    expect(built.params).toEqual({ from: 1, to: 2 });
  });
});

describe('paintFromRows', () => {
  it('maps score rows to node sizes', () => {
    const paint = paintFromRows(findAlgorithm('algo.pagerank')!, ['node', 'score'], [[1, 0.4], [2, 0.9]]);
    expect(paint.scores.get(1)).toBe(0.4);
    expect(paint.scores.get(2)).toBe(0.9);
    expect(paint.communities.size).toBe(0);
    expect(paint.paths).toEqual([]);
  });

  it('maps community rows to node colors', () => {
    const paint = paintFromRows(findAlgorithm('algo.louvain')!, ['node', 'community'], [[1, 0], [2, 1]]);
    expect(paint.communities.get(1)).toBe(0);
    expect(paint.communities.get(2)).toBe(1);
  });

  it('maps a path result to highlighted node sequences', () => {
    const paint = paintFromRows(
      findAlgorithm('algo.shortestPath')!,
      ['path', 'cost'],
      [[{ nodes: [1, 2, 3], edges: [10, 11] }, 2]],
    );
    expect(paint.paths).toEqual([[1, 2, 3]]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -F web exec ng test --watch=false`
Expected: FAIL — `./algorithms` not found.

- [ ] **Step 3: Implement `apps/web/src/app/workspace/algorithms.ts`**

```ts
import type { AlgorithmPaint } from './workspace-graph-store.contract';

export type ParamType = 'number' | 'string' | 'nodeId' | 'enum';

export interface AlgorithmParam {
  key: string;
  label: string;
  type: ParamType;
  required?: boolean;
  default?: number | string;
  /** For `enum` params. */
  options?: string[];
}

/** How an algorithm's YIELD rows map to canvas styling. */
export type PaintKind = 'score' | 'community' | 'component' | 'path' | 'none';

export interface AlgorithmSpec {
  name: string; // e.g. 'algo.pagerank'
  label: string; // human title
  params: AlgorithmParam[];
  yields: string[]; // YIELD column names (verified against packages/query/src/call.ts)
  paint: PaintKind;
}

/** v1 algorithm set with parameters + defaults pinned to spec §5.2. */
export const ALGORITHMS: readonly AlgorithmSpec[] = [
  {
    name: 'algo.pagerank',
    label: 'PageRank',
    params: [
      { key: 'damping', label: 'Damping', type: 'number', default: 0.85 },
      { key: 'iterations', label: 'Iterations', type: 'number', default: 20 },
    ],
    yields: ['node', 'score'],
    paint: 'score',
  },
  {
    name: 'algo.louvain',
    label: 'Louvain communities',
    params: [{ key: 'maxLevels', label: 'Max levels', type: 'number', default: 10 }],
    yields: ['node', 'community'],
    paint: 'community',
  },
  {
    name: 'algo.components',
    label: 'Connected components',
    params: [{ key: 'mode', label: 'Mode', type: 'enum', options: ['weak', 'strong'], default: 'weak' }],
    yields: ['node', 'component'],
    paint: 'component',
  },
  {
    name: 'algo.degree',
    label: 'Degree centrality',
    params: [{ key: 'direction', label: 'Direction', type: 'enum', options: ['both', 'out', 'in'], default: 'both' }],
    yields: ['node', 'score'],
    paint: 'score',
  },
  {
    name: 'algo.betweenness',
    label: 'Betweenness centrality',
    params: [{ key: 'sampleK', label: 'Sample K (optional)', type: 'number' }],
    yields: ['node', 'score'],
    paint: 'score',
  },
  {
    name: 'algo.shortestPath',
    label: 'Shortest path',
    params: [
      { key: 'from', label: 'From node id', type: 'nodeId', required: true },
      { key: 'to', label: 'To node id', type: 'nodeId', required: true },
      { key: 'weightProp', label: 'Weight property (optional)', type: 'string' },
    ],
    yields: ['path', 'cost'],
    paint: 'path',
  },
  {
    name: 'algo.allShortestPaths',
    label: 'All shortest paths',
    params: [
      { key: 'from', label: 'From node id', type: 'nodeId', required: true },
      { key: 'to', label: 'To node id', type: 'nodeId', required: true },
      { key: 'type', label: 'Edge type (optional)', type: 'string' },
    ],
    yields: ['path', 'cost'],
    paint: 'path',
  },
  {
    name: 'algo.bfs',
    label: 'Breadth-first search',
    params: [
      { key: 'from', label: 'From node id', type: 'nodeId', required: true },
      { key: 'type', label: 'Edge type (optional)', type: 'string' },
      { key: 'maxDepth', label: 'Max depth (optional)', type: 'number' },
    ],
    yields: ['node', 'depth'],
    paint: 'score',
  },
  {
    name: 'algo.dfs',
    label: 'Depth-first search',
    params: [
      { key: 'from', label: 'From node id', type: 'nodeId', required: true },
      { key: 'type', label: 'Edge type (optional)', type: 'string' },
      { key: 'maxDepth', label: 'Max depth (optional)', type: 'number' },
    ],
    yields: ['node', 'depth'],
    paint: 'score',
  },
  {
    name: 'algo.topoSort',
    label: 'Topological sort',
    params: [{ key: 'type', label: 'Edge type (optional)', type: 'string' }],
    yields: ['node', 'order'],
    paint: 'score',
  },
  {
    name: 'algo.cycles',
    label: 'Cycle detection',
    params: [{ key: 'type', label: 'Edge type (optional)', type: 'string' }],
    yields: ['cycle'],
    paint: 'path',
  },
];

export function findAlgorithm(name: string): AlgorithmSpec | undefined {
  return ALGORITHMS.find((a) => a.name === name);
}

export interface BuiltCall {
  query: string;
  params: Record<string, number | string>;
}

/** Whether a form value should be included (skip blanks for optional params). */
function isSet(v: number | string | undefined): v is number | string {
  return v !== undefined && v !== '' && !(typeof v === 'number' && Number.isNaN(v));
}

/**
 * Build an injection-safe `CALL algo.<name>({k: $k, …}) YIELD … RETURN …` string.
 * Every literal flows through `$params`, never string interpolation.
 */
export function buildAlgorithmCall(spec: AlgorithmSpec, values: Record<string, number | string>): BuiltCall {
  const params: Record<string, number | string> = {};
  const entries: string[] = [];
  for (const p of spec.params) {
    const v = values[p.key];
    if (isSet(v)) {
      params[p.key] = v;
      entries.push(`${p.key}: $${p.key}`);
    }
  }
  const optionsMap = entries.length > 0 ? `{${entries.join(', ')}}` : '';
  const yields = spec.yields.join(', ');
  return {
    query: `CALL ${spec.name}(${optionsMap}) YIELD ${yields} RETURN ${yields}`,
    params,
  };
}

interface PathLike {
  nodes: number[];
  edges: number[];
}

function isPathLike(v: unknown): v is PathLike {
  return typeof v === 'object' && v !== null && Array.isArray((v as PathLike).nodes);
}

/**
 * Map YIELD rows to canvas styling (§7.2): node size from score, color from
 * community/component, highlighted node sequences from path/cycle results.
 */
export function paintFromRows(spec: AlgorithmSpec, columns: string[], rows: unknown[][]): AlgorithmPaint {
  const scores = new Map<number, number>();
  const communities = new Map<number, number>();
  const paths: number[][] = [];
  const nodeIdx = columns.indexOf('node');
  const valueCol = spec.paint === 'community' ? 'community' : spec.paint === 'component' ? 'component' : 'score';
  const valueIdx = spec.yields.includes(valueCol) ? columns.indexOf(valueCol) : columns.indexOf('depth');

  for (const row of rows) {
    if (spec.paint === 'path') {
      const cell = row[columns.indexOf(spec.yields[0]!)];
      if (isPathLike(cell)) paths.push(cell.nodes);
      continue;
    }
    if (nodeIdx === -1) continue;
    const id = row[nodeIdx];
    if (typeof id !== 'number') continue;
    const value = valueIdx === -1 ? 0 : row[valueIdx];
    if (typeof value !== 'number') continue;
    if (spec.paint === 'community' || spec.paint === 'component') communities.set(id, value);
    else scores.set(id, value);
  }
  return { scores, communities, paths };
}
```

- [ ] **Step 4: Implement the Algorithms view**

`apps/web/src/app/workspace/algorithms-view.ts`:

```ts
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { AtlasApi } from '../core/atlas-api';
import { ALGORITHMS, buildAlgorithmCall, paintFromRows, type AlgorithmSpec } from './algorithms';
import { WORKSPACE_GRAPH_STORE } from './workspace-graph-store.contract';

@Component({
  selector: 'app-algorithms-view',
  imports: [FormsModule],
  templateUrl: './algorithms-view.html',
})
export class AlgorithmsView {
  private readonly api = inject(AtlasApi);
  private readonly route = inject(ActivatedRoute);
  private readonly graphStore = inject(WORKSPACE_GRAPH_STORE, { optional: true });

  readonly algorithms = ALGORITHMS;
  readonly selected = signal<AlgorithmSpec>(ALGORITHMS[0]!);
  readonly values = signal<Record<string, number | string>>(defaults(ALGORITHMS[0]!));
  readonly running = signal(false);
  readonly error = signal('');
  readonly painted = signal(0);

  select(spec: AlgorithmSpec): void {
    this.selected.set(spec);
    this.values.set(defaults(spec));
    this.error.set('');
  }

  setValue(key: string, raw: string, isNumber: boolean): void {
    this.values.update((v) => ({ ...v, [key]: isNumber ? Number(raw) : raw }));
  }

  async run(): Promise<void> {
    const name = this.route.snapshot.paramMap.get('name') ?? '';
    const spec = this.selected();
    const { query, params } = buildAlgorithmCall(spec, this.values());
    this.running.set(true);
    this.error.set('');
    try {
      const res = await this.api.database(name).query(query, params);
      const paint = paintFromRows(spec, res.columns, res.rows);
      this.graphStore?.paintAlgorithmResult(paint);
      this.painted.set(paint.scores.size + paint.communities.size + paint.paths.length);
    } catch (e) {
      this.error.set((e as { message?: string }).message ?? 'Algorithm failed.');
    } finally {
      this.running.set(false);
    }
  }
}

function defaults(spec: AlgorithmSpec): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const p of spec.params) if (p.default !== undefined) out[p.key] = p.default;
  return out;
}
```

`apps/web/src/app/workspace/algorithms-view.html`:

```html
<section class="algorithms-view" aria-label="Algorithms">
  <h1>Algorithms</h1>
  <div class="algo-layout">
    <nav class="algo-list" aria-label="Algorithm list">
      @for (a of algorithms; track a.name) {
        <button type="button" [class.active]="a.name === selected().name" (click)="select(a)">
          {{ a.label }}
        </button>
      }
    </nav>
    <form class="algo-form" (ngSubmit)="run()">
      <h2>{{ selected().label }}</h2>
      @for (p of selected().params; track p.key) {
        <label [attr.for]="'param-' + p.key">{{ p.label }}</label>
        @if (p.type === 'enum') {
          <select
            [id]="'param-' + p.key"
            [ngModel]="values()[p.key]"
            [name]="p.key"
            (ngModelChange)="setValue(p.key, $event, false)"
          >
            @for (opt of p.options; track opt) {
              <option [value]="opt">{{ opt }}</option>
            }
          </select>
        } @else {
          <input
            [id]="'param-' + p.key"
            [name]="p.key"
            [type]="p.type === 'string' ? 'text' : 'number'"
            [ngModel]="values()[p.key]"
            (ngModelChange)="setValue(p.key, $event, p.type !== 'string')"
          />
        }
      }
      <button type="submit" [disabled]="running()">{{ running() ? 'Running…' : 'Run' }}</button>
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
      @if (painted() > 0) {
        <p class="painted">Painted {{ painted() }} results onto the canvas.</p>
      }
    </form>
  </div>
</section>
```

In `apps/web/src/app/app.routes.ts`, add:

```ts
{
  path: 'db/:name/algorithms',
  canActivate: [authGuard],
  loadComponent: () => import('./workspace/algorithms-view').then((m) => m.AlgorithmsView),
},
```

- [ ] **Step 5: Write the Playwright e2e (excluded from the default gate)**

`apps/web/e2e/console.spec.ts` (uses the same same-origin webServer from M6a's `playwright.config.ts`):

```ts
import { expect, test } from '@playwright/test';

test('open the workspace console, run a query, see results; open the schema view', async ({ page }) => {
  const username = `e2e_console_${Date.now()}`;

  // Register (logs in) and land on the picker.
  await page.goto('/register');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('secret12');
  await page.getByRole('button', { name: /create account/i }).click();
  await expect(page).toHaveURL(/\/databases$/);

  // Create and seed a database so there is data to query.
  await page.getByPlaceholder('new-database').fill('e2e-console');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('e2e-console')).toBeVisible();
  await page.getByRole('button', { name: /seed science-history/i }).click();

  // Open the workspace console and run a query.
  await page.goto('/db/e2e-console');
  await expect(page.getByLabel('AQL console')).toBeVisible();
  // Replace the editor contents and run via the Mod-Enter shortcut.
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('MATCH (p:Person) RETURN p.name AS name LIMIT 5');
  await page.keyboard.press('Control+Enter');

  // Results table shows the "name" column.
  await expect(page.getByRole('columnheader', { name: 'name' })).toBeVisible();

  // Open the schema view and see at least one label box.
  await page.goto('/db/e2e-console/schema');
  await expect(page.getByRole('heading', { name: 'Schema' })).toBeVisible();
  await expect(page.locator('.schema-node').first()).toBeVisible();
});
```

The e2e script `e2e` and the root `e2e:web` already exist (M6a). The workspace route `/db/:name` is a placeholder in M6a; M6b adds the canvas. If M6b has not yet mounted `<app-console>` into the `/db/:name` route when this e2e runs, mark this spec `test.fixme` with a comment pointing at the M6b dependency and keep the schema-view half (which is fully owned by M6c) active; flip it on once M6b mounts the console. (Boundary noted in the self-review.)

- [ ] **Step 6: Run the e2e to verify it passes (or is correctly fixme'd)**

Run: `pnpm -F web e2e`
Expected: PASS — register→picker→create→seed→console query→results header→schema view label box. If the console is not yet mounted by M6b, the schema-view assertions still pass and the console half is `fixme`'d with the dependency noted (do not weaken assertions).

- [ ] **Step 7: Update the README**

In `README.md`, set the `**Status:**` block to:

```markdown
**Status:** M6c — Knowledge Graph Explorer: AQL console, schema view, and
algorithms view. The bottom-dock console is a CodeMirror 6 editor with AQL
syntax highlighting, schema-aware autocomplete, and ⌘/Ctrl+Enter to run; it
shows a Results table, a visual EXPLAIN Plan tree, and a localStorage-persisted
History tab, surfaces AqlError as a caret-positioned message, and can project
node-bearing results onto the canvas. The Schema view auto-generates a diagram
of labels (with counts) and edge types from `Database.schema()` introspection.
The Algorithms view offers parameter forms for the v1 algorithm set
(PageRank/Louvain/components/degree/betweenness/shortest paths/BFS/DFS/topoSort/
cycles), runs them via `CALL algo.*`, and paints results onto the canvas (node
size = score, color = community, highlighted paths). Parsing/tokenizing/
completion/plan-transform/history/schema-layout are plain-TS Vitest modules;
Angular + CodeMirror are thin wrappers. The canvas itself is M6b; admin + import
UI + final polish are M6d.
```

- [ ] **Step 8: Run the full gate**

Run: `pnpm build && pnpm typecheck:test && pnpm lint && pnpm format && pnpm test`
Expected: all green — `tsc -b` builds the libraries (ignoring `apps/web`), the Angular builder builds the app (CodeMirror resolves), `typecheck:test` is unchanged, eslint + prettier cover the new `apps/web/src/app/workspace` files, and `pnpm test` runs the library Vitest suite plus the app's `ng test` (all M6c specs). The Playwright e2e is intentionally excluded (run separately via `pnpm e2e:web`).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(web): algorithms view, console e2e smoke, and full M6c gate green"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## Plan self-review notes

- **Spec coverage (§7.2 console + schema/algorithms views, §5.2/§4.6/§4.7):**

  | Spec requirement | Tasks |
  |---|---|
  | §7.2 console: editor with **highlighting** | T1 (`aql-language` tokenizer + `StreamLanguage` + theme-aware `HighlightStyle`) |
  | §7.2 console: **schema-aware autocomplete** | T2 (`computeCompletions` from `SchemaSummary` + keywords/procedures; CodeMirror `CompletionSource`) |
  | §7.2 console: **error squiggles** | T3 (structured `ConsoleError` from `AqlError` problem-details: caret message + snippet banner; inline `Decoration` squiggle is a noted v1 boundary) |
  | §7.2 console: run shortcut (⌘/Ctrl+Enter) | T1 (`keymap` `Mod-Enter`) |
  | §7.2 console tabs: **Results table** | T3 (`results-table` + `cell-format`) |
  | §7.2 console tabs: **visual EXPLAIN Plan** | T4 (`EXPLAIN <query>` → `planToTree` → tree view) |
  | §7.2 console tabs: **History** | T5 (`history.store`, localStorage, re-run) |
  | §7.2 console: **results projected onto the canvas** | T6 (`resultToGraph` + `WorkspaceGraphStore.setGraph`) |
  | §7.2 + §4.6 **Schema view** (labels w/ counts, edge types from→to) | T7 (`buildSchemaDiagram` + SVG) |
  | §7.2 + §4.7 **Algorithms view** (parameter forms; paint node size=score, color=community, highlighted paths) | T8 (`ALGORITHMS` catalog + `buildAlgorithmCall` + `paintFromRows` + `WorkspaceGraphStore.paintAlgorithmResult`) |
  | §5.2 `CALL algo.<name>` signature table | T8 (params/defaults/yields pinned to the table; verified against `packages/query/src/call.ts`) |
  | §5.2 `EXPLAIN <query>` → structured JSON rendered visually | T4 |
  | §5.4 errors carry `{ code, line, column, snippet }` | T3 |

- **Verified API correctness (against the actual source tree, not memory):**
  - **Query-row node/edge shape:** `RETURN p` yields a `NodeRecord` serialized with `props` (not `properties`) — query rows pass `executeQuery`'s `QueryResult` through `routes/query.ts` untouched. Node detection (`isNodeCell`) keys on numeric `id` + `labels` array; edge detection on `id`+`type`+`from`+`to`. This is the single most error-prone assumption and is grounded in `packages/query/src/{eval,exec,api}.ts` + `packages/core/src/types.ts`.
  - **Algorithm `node` is a bare `NodeId` number**, not a node object (confirmed in `packages/core/src/algo/*` and `packages/query/src/call.ts`). So `paintFromRows` reads `row[nodeIdx]` as a number and maps id→score/community — it does NOT call `extractGraphElements` (which only finds node *objects*). `path`/`cycle` cells are `PathResult { nodes: number[]; edges: number[] }`, so `paths.push(cell.nodes)`.
  - **EXPLAIN output:** `{ columns: ['plan'], rows: [[planJson]] }`; `planJson` recurses via `child` (unary) and `left`/`right` (CartesianProduct); write/DDL/call plans are flat (`{ op: 'Write', steps: [...] }` etc.). `planToTree` handles all of these and is closed under unknown shapes.
  - **`SchemaSummary`** fields (`labels[].properties[].{property,types}`, `edgeTypes[].{from,to}` as `Record<string,number>`) match `packages/core/src/schema.ts`; `buildSchemaDiagram` resolves endpoints by the **dominant** from/to label.
  - **`AqlError` → problem-details:** the server maps parse/semantic/runtime to HTTP 400 with `{ code, line, column, snippet, detail }` (`packages/server/src/errors.ts`); `@atlas/client` throws `AtlasClientError { problem }`. `toConsoleError` reads `e.problem` first, falls back to `e.message`.
  - **CodeMirror 6 API** usage is real for v6: `StreamLanguage.define({ token })`, `LanguageSupport`, `HighlightStyle.define` + `syntaxHighlighting` from `@codemirror/language`; `tags` from `@lezer/highlight`; `autocompletion({ override: [source] })` + `CompletionContext.matchBefore` + `CompletionResult { from, options, validFor }` from `@codemirror/autocomplete`; `history`/`defaultKeymap`/`historyKeymap` from `@codemirror/commands`; `EditorView`/`EditorState`/`keymap`/`lineNumbers`/`Decoration`/`updateListener` from `@codemirror/view`+`@codemirror/state`. `Mod-Enter` is the canonical platform-agnostic Ctrl/Cmd binding.

- **Consistent interfaces / cross-task anchors:**
  - The M6b integration is **one named contract**: `WorkspaceGraphStore { setGraph(GraphPayload); paintAlgorithmResult(AlgorithmPaint) }`, exposed via the `WORKSPACE_GRAPH_STORE` injection token (T6), consumed by the console store (T6) and the algorithms view (T8). M6c provides `InMemoryWorkspaceGraphStore` as the default; M6b overrides the token. Named identically everywhere.
  - `AtlasApi.database(name)` → `Database` with `.query(aql, params) → QueryResponse` and `.schema() → SchemaSummary` is the only server door (matches M6a). `SchemaSummary` is re-exported from `@atlas/client` (M6a added the `@atlas/core` type dep), so the app imports it from `@atlas/client`.
  - `GraphNode`/`GraphEdge` are defined once in `cell-format.ts` and reused by `workspace-graph-store.contract.ts`; `AlgorithmPaint` is defined once in the contract and reused by `algorithms.ts`.
  - Routes: `/db/:name` (M6b canvas host, M6c mounts the console into it), `/db/:name/schema` (T7), `/db/:name/algorithms` (T8) — all under `authGuard`, `**` redirect stays last. localStorage keys: `atlas.history.<db>` (T5).

- **Deliberate v1 decisions (called out):**
  - **Custom lightweight AQL highlighting, not a full Lezer grammar.** A hand-written `StreamLanguage` tokenizer covers keywords/strings/numbers/params/labels/operators/comments — enough for highlighting + completion-context detection — without the cost/maintenance of a generated grammar. The same `tokenizeAql` is unit-tested directly and reused by the CodeMirror stream tokenizer, so the highlighting logic is verified without a running editor.
  - **Autocomplete sources:** schema-driven (labels after `:`, edge types after `[:`, properties after `ident.`, procedures after `algo.`) plus static keyword/function/procedure lists, all prefix-filtered. Property completion offers *all* schema property names (not narrowed to the bound label's properties) — a deliberate v1 simplification (variable→label binding resolution is deferred; noted).
  - **Results-with-nodes detection** keys on the serialized `NodeRecord`/`EdgeRecord` shape (numeric `id` + `labels`/`type`…), de-duplicated by id (`extractGraphElements`). Projection is an explicit "Project to canvas" action (and a `projectable` signal), so it is deterministically testable; auto-projection on every node-bearing result is intentionally not the default to avoid surprising canvas churn.
  - **Inline error squiggle** is rendered as a caret-positioned banner + snippet in v1 (the asserted surface); a CodeMirror `Decoration.mark` over the offending column is a thin add-on noted for when it can be asserted through the editor, not the banner.
  - **EXPLAIN Plan rendering** is an indented tree (depth-ordered rows) rather than a graphical node-box diagram — readable, accessible (`role="tree"`), and fully transform-tested; a richer visual is an M6d polish item.
  - **Algorithm CALL building is injection-safe by construction**: every parameter flows through `$params`; blanks for optional params are omitted from the options map. Matches §5.2's "$parameters … injection-safe by construction."

- **Boundaries with adjacent milestones:**
  - **M6b (workspace canvas — the consumer of "project onto canvas"):** M6b owns the Canvas2D/d3-force renderer and the `/db/:name` workspace shell that hosts both the canvas and this console. M6c depends on it only through `WorkspaceGraphStore`; since M6b is concurrent and absent at authoring time, M6c **defines** that contract and ships an in-memory default, so M6c is independently buildable, testable, and gate-green. M6b implements the same token (or an M6d adapter bridges). The console-half of the Playwright e2e is `fixme`-guarded if M6b has not yet mounted `<app-console>` into `/db/:name`; the M6c-owned schema-view half always runs.
  - **M6d (admin + import UI + theming polish):** users/tokens/roles/audit/db-settings screens, file import, full WCAG-AA contrast verification of console/diagram colors across all three themes, the inline-squiggle decoration, and richer EXPLAIN visuals are M6d. M6c uses the existing theme tokens (`--accent`, `--node-*`, `--text-muted`) for highlighting and the schema/algorithm coloring so it inherits theming for free.

- **Self-review fixes applied:** pinned algorithm params/defaults/yields to the verified `call.ts` (e.g. `algo.pagerank` yields `node, score` with `damping=0.85`, `iterations=20`); corrected `paintFromRows` to treat algorithm `node` cells as numbers (not objects) and `path`/`cycle` cells as `{ nodes, edges }`; corrected query-row node detection to `props` (not `properties`); kept all pure logic (tokenizer, completions, cell-format, plan transform, history, schema layout, algorithm spec/builder/paint) in framework-free modules unit-tested under the app's Vitest runner; made the M6b dependency a single named injectable contract with a working default so nothing in M6c is blocked on M6b; confirmed every CodeMirror import path/symbol against the v6 package layout; ensured commands use `pnpm -F web exec ng test --watch=false` (never bare vitest) and the e2e stays out of the default gate.
