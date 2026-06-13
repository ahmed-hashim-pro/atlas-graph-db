import type { EdgeRecord, GraphStore, NodeId, NodeRecord, Props, TxBuilder } from '@atlas/core';
import type { Expr, PathPattern, SetItem, WriteClause, WriteQuery } from './ast.js';
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
  props: { property: string; value: Expr }[],
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

/**
 * CREATE a path pattern within one binding row, binding new variables as it goes.
 * Freshly-created records are stashed into the binding carrying their evaluated
 * props so a trailing RETURN can read them: the store does not reflect staged
 * ops until the surrounding transaction commits, so an in-tx store re-read would
 * miss them.
 */
function createPattern(pat: PathPattern, ctx: WriteCtx, binding: Binding): void {
  const nodeIds: NodeId[] = [];
  for (const n of pat.nodes) {
    if (n.variable && binding.has(n.variable)) {
      nodeIds.push((binding.get(n.variable) as NodeRecord).id);
      continue;
    }
    if (n.labels.length === 0)
      throw new AqlError(
        'RUNTIME_ERROR',
        'CREATE node requires at least one label',
        n.pos,
        ctx.eval.source,
      );
    const props = evalProps(n.props, ctx, binding);
    const id = ctx.tx.createNode(n.labels, props);
    ctx.stats.created++;
    nodeIds.push(id);
    if (n.variable) binding.set(n.variable, { id, labels: [...n.labels], props } as NodeRecord);
  }
  for (let i = 0; i < pat.edges.length; i++) {
    const e = pat.edges[i]!;
    if (e.types.length !== 1)
      throw new AqlError(
        'RUNTIME_ERROR',
        'CREATE edge requires exactly one type',
        e.pos,
        ctx.eval.source,
      );
    const dir = e.direction;
    if (dir === 'both')
      throw new AqlError('RUNTIME_ERROR', 'CREATE edges must be directed', e.pos, ctx.eval.source);
    const [from, to] =
      dir === 'in' ? [nodeIds[i + 1]!, nodeIds[i]!] : [nodeIds[i]!, nodeIds[i + 1]!];
    const id = ctx.tx.createEdge(e.types[0]!, from, to, {});
    ctx.stats.created++;
    if (e.variable)
      binding.set(e.variable, { id, type: e.types[0]!, from, to, props: {} } as EdgeRecord);
  }
}

function applySet(items: SetItem[], ctx: WriteCtx, binding: Binding): void {
  for (const s of items) {
    const rec = binding.get(s.target);
    if (!rec)
      throw new AqlError(
        'RUNTIME_ERROR',
        `SET target "${s.target}" is not bound`,
        s.pos,
        ctx.eval.source,
      );
    const v = evalExpr(s.value, binding, ctx.eval);
    const isEdge = 'type' in rec;
    // Stage the prop change on the tx only — do NOT mutate the live store record
    // (matched records are the store's own objects; out-of-band mutation would
    // break statement atomicity and index consistency on rollback).
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
        const rec = binding.get(r.target);
        if (!rec)
          throw new AqlError(
            'RUNTIME_ERROR',
            `REMOVE target "${r.target}" is not bound`,
            r.pos,
            ctx.eval.source,
          );
        if ('type' in rec) ctx.tx.setEdgeProps(rec.id, {}, [r.property]);
        else ctx.tx.setNodeProps(rec.id, {}, [r.property]);
        ctx.stats.propsSet++;
      }
      return;
    case 'delete':
      for (const target of clause.targets) {
        const name = (target as { name: string }).name;
        const rec = binding.get(name);
        if (!rec)
          throw new AqlError(
            'RUNTIME_ERROR',
            `DELETE target "${name}" is not bound`,
            clause.pos,
            ctx.eval.source,
          );
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

  // Per-row post-write bindings, kept in a parallel array (no Map field hack).
  const finals: Binding[] = [];
  for (const baseBinding of rows) {
    const binding = new Map(baseBinding);
    for (const clause of query.clauses) runClause(clause, ctx, binding);
    finals.push(binding);
  }

  // RETURN projection over post-write bindings.
  if (!query.returnItems) return { columns: [], rows: [], stats: ctx.stats };
  const columns = query.returnItems.map((it, i) => it.alias ?? `col${i}`);
  let outRows: RuntimeValue[][] = finals.map((b) =>
    query.returnItems!.map((it) => evalExpr(it.expr, b, ctx.eval)),
  );
  if (query.returnDistinct) outRows = dedupRows(outRows);
  return { columns, rows: outRows, stats: ctx.stats };
}

function dedupRows(rows: RuntimeValue[][]): RuntimeValue[][] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = JSON.stringify(
      r.map((v) => (v && typeof v === 'object' && 'id' in v ? `#${v.id}` : v)),
    );
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
