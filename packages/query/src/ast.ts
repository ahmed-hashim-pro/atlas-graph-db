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
  | { kind: 'and'; left: Expr; right: Expr; pos: Pos }
  | { kind: 'or'; left: Expr; right: Expr; pos: Pos }
  | { kind: 'cmp'; op: '=' | '<>' | '<' | '<=' | '>' | '>='; left: Expr; right: Expr; pos: Pos }
  | { kind: 'in'; needle: Expr; haystack: Expr; pos: Pos }
  | { kind: 'text'; op: 'contains' | 'startsWith' | 'endsWith'; left: Expr; right: Expr; pos: Pos }
  | { kind: 'exists'; target: string; property: string; pos: Pos }
  | { kind: 'list'; items: Expr[]; pos: Pos }
  | { kind: 'call'; func: string; arg: Expr | '*'; distinct: boolean; pos: Pos };

export const AGGREGATES = new Set(['count', 'collect', 'sum', 'avg', 'min', 'max']);
export const SCALAR_FUNCS = new Set(['id', 'labels', 'type', 'lower']);

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
  | {
      stmt: 'createIndex';
      kind: 'property' | 'fulltext' | 'unique';
      label: string;
      property: string;
      pos: Pos;
    }
  | {
      stmt: 'dropIndex';
      kind: 'property' | 'fulltext' | 'unique';
      label: string;
      property: string;
      pos: Pos;
    }
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
