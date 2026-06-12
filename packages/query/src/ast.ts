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
