import type { PropertyValue } from '../types.js';

/** Indexable scalar property values. Arrays are not indexable in v1. */
export type ScalarValue = string | number | boolean | Date;

export function isScalar(v: PropertyValue): v is ScalarValue {
  return !Array.isArray(v);
}

/** Cross-type ordering rank: number < string < boolean < date. */
export function typeRank(v: ScalarValue): number {
  if (typeof v === 'number') return 0;
  if (typeof v === 'string') return 1;
  if (typeof v === 'boolean') return 2;
  return 3;
}

/** Canonical exact-match key; the type tag keeps 1 and '1' distinct. */
export function encodeKey(v: ScalarValue): string {
  if (typeof v === 'number') return `n:${v}`;
  if (typeof v === 'string') return `s:${v}`;
  if (typeof v === 'boolean') return `b:${v ? 1 : 0}`;
  return `d:${v.getTime()}`;
}

/** Total order over scalars: type rank first, then natural order within the type. */
export function compareValues(a: ScalarValue, b: ScalarValue): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === 'number') return a - (b as number);
  if (typeof a === 'string') return a < (b as string) ? -1 : a > (b as string) ? 1 : 0;
  if (typeof a === 'boolean') return Number(a) - Number(b as boolean);
  return a.getTime() - (b as Date).getTime();
}
