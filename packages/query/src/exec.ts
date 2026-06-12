import type { EdgeRecord, GraphStore, NodeRecord } from '@atlas/core';
import { type Expr, type ReadQuery } from './ast.js';
import { AqlError } from './errors.js';
import {
  compareRuntime,
  evalExpr,
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
