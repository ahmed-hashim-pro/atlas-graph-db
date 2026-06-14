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
  const estCostRaw = plan['estCost'];
  out.push({
    depth,
    op: String(plan['op']),
    detail: detailOf(plan),
    estCost: typeof estCostRaw === 'number' ? estCostRaw : undefined,
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
