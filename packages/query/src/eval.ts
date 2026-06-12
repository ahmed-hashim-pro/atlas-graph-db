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
  return (
    typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && 'id' in v
  );
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
        throw new AqlError(
          'RUNTIME_ERROR',
          `${e.func}() expects a bound variable`,
          e.pos,
          ctx.source,
        );
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
