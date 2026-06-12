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
      const op =
        e.op === 'contains' ? 'CONTAINS' : e.op === 'startsWith' ? 'STARTS WITH' : 'ENDS WITH';
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
