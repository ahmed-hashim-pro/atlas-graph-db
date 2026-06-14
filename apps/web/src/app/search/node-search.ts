import type { QueryResponse } from '@atlas/protocol';

export interface NodeHit {
  id: string;
  labels: string[];
  /** Human display string derived from the node's props (falls back to "#id"). */
  label: string;
}

/** Props checked, in order, to derive a node's display label. */
const NAME_KEYS = ['name', 'title', 'label', 'username', 'id'];

interface RawNode {
  id: string | number;
  labels?: string[];
  props?: Record<string, unknown>;
}
function isRawNode(v: unknown): v is RawNode {
  return typeof v === 'object' && v !== null && 'id' in v && 'props' in v && 'labels' in v;
}

/**
 * Build a parameterized AQL query that finds nodes whose `name` or `title`
 * property CONTAINS the term. The term and limit are always bound as
 * `$term`/`$limit` — never string-interpolated — so the search is injection-safe.
 *
 * Constrained to what the engine actually supports (verified in
 * `@atlas/query` `eval.ts`/`parser.ts`): the only scalar functions are
 * `id()`/`labels()`/`type()` (no `toLower`/`toString`), and `CONTAINS` is the
 * `text` op which returns `false` unless BOTH operands are strings — so it is
 * case-sensitive and only matches string-valued `name`/`title` props. We bind
 * the term verbatim (trimmed) and OR the two most common name-ish properties;
 * `CONTAINS` uses the full-text index when present and falls back to a scan
 * otherwise (spec §4.5), which is fine for the explorer's interactive cap.
 */
export function searchQuery(
  term: string,
  limit: number,
): {
  query: string;
  params: { term: string; limit: number };
} {
  const query =
    'MATCH (n) WHERE n.name CONTAINS $term OR n.title CONTAINS $term RETURN n LIMIT $limit';
  return { query, params: { term: term.trim(), limit } };
}

/** Map a node-shaped query result into display hits, ignoring non-node cells. */
export function toHits(res: QueryResponse): NodeHit[] {
  const hits: NodeHit[] = [];
  const seen = new Set<string>();
  for (const row of res.rows)
    for (const cell of row) {
      if (!isRawNode(cell)) continue;
      const id = String(cell.id);
      if (seen.has(id)) continue;
      seen.add(id);
      hits.push({ id, labels: cell.labels ?? [], label: displayLabel(cell) });
    }
  return hits;
}

function displayLabel(node: RawNode): string {
  const props = node.props ?? {};
  for (const key of NAME_KEYS) {
    const v = props[key];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
  }
  return `#${node.id}`;
}
