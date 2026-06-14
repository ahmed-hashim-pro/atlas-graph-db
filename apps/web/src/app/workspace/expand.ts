import type { QueryResponse } from '@atlas/protocol';
import { DEFAULT_EXPAND_CAP, type GraphData, type GraphEdge, type GraphNode } from './graph-model';

/**
 * A node value as returned in a graph-shaped `Database.query` row. The engine
 * emits raw `NodeRecord`s, whose property bag is `props` (see `@atlas/core`
 * `NodeRecord`). `properties` is accepted as a fallback for the REST data-route
 * shape, but `props` is the wire contract that `Database.query` actually returns.
 */
interface RawNode {
  id: string | number;
  labels?: string[];
  props?: Record<string, unknown>;
  properties?: Record<string, unknown>;
}
/**
 * An edge value as returned in a graph-shaped `Database.query` row. The engine
 * emits raw `EdgeRecord`s, whose property bag is `props` (see `@atlas/core`
 * `EdgeRecord`); `properties` is accepted only as a fallback.
 */
interface RawEdge {
  id: string | number;
  type?: string;
  from?: string | number;
  to?: string | number;
  props?: Record<string, unknown>;
  properties?: Record<string, unknown>;
}

/**
 * Parameterized AQL to fetch a capped, paged page of a node's neighbors (both
 * directions).
 *
 * `id` arrives as a string (the Inspector emits the selected node id as a
 * string, and ids round-trip through the store as strings), but engine node ids
 * are always numeric (`@atlas/core` `NodeId = number`) and AQL's `id(n)`
 * evaluates to a number. The engine's equality is type-strict (a number never
 * equals a string), so `$id` MUST be bound as a number or the WHERE never
 * matches and the query returns zero neighbors. We coerce here and reject any
 * id that is not a finite integer so a bad id surfaces loudly instead of
 * silently expanding nothing.
 */
export function neighborQuery(
  id: string,
  limit: number = DEFAULT_EXPAND_CAP,
  skip = 0,
): { query: string; params: Record<string, unknown> } {
  // `Number('')` / `Number('  ')` silently coerce to 0, so reject blank input
  // before the numeric check or an empty id would expand node 0's neighbors.
  const numId = id.trim() === '' ? NaN : Number(id);
  if (!Number.isInteger(numId)) {
    throw new Error(`neighborQuery: node id must be an integer, got ${JSON.stringify(id)}`);
  }
  return {
    query:
      'MATCH (n)-[r]-(m) WHERE id(n) = $id RETURN n, r, m ORDER BY id(m) SKIP $skip LIMIT $limit',
    params: { id: numId, limit, skip },
  };
}

function isRawNode(v: unknown): v is RawNode {
  return typeof v === 'object' && v !== null && 'id' in v && 'labels' in v;
}
function isRawEdge(v: unknown): v is RawEdge & { from: string | number; to: string | number } {
  // Require from/to to be present AND defined so a malformed edge cell with an
  // undefined endpoint is skipped rather than coerced to the literal 'undefined'
  // by toEdge (which mergeGraph would then silently drop). The engine always
  // populates from/to, so this only guards against malformed input.
  if (typeof v !== 'object' || v === null) return false;
  if (!('id' in v) || !('type' in v) || !('from' in v) || !('to' in v)) return false;
  const e = v as RawEdge;
  return e.from != null && e.to != null;
}
function toNode(raw: RawNode): GraphNode {
  return { id: String(raw.id), labels: raw.labels ?? [], props: raw.props ?? raw.properties ?? {} };
}
function toEdge(raw: RawEdge): GraphEdge {
  return {
    id: String(raw.id),
    from: String(raw.from),
    to: String(raw.to),
    type: raw.type ?? '',
    props: raw.props ?? raw.properties ?? {},
  };
}

/**
 * Collect every node/edge value found in any cell of a graph-shaped result,
 * deduped by id. Endpoint integrity is NOT enforced here: edges whose endpoints
 * are not present are kept and dropped/held later by `GraphStore.addGraph`
 * (`mergeGraph`), so this stays a pure shape transform.
 */
export function parseGraphRows(res: QueryResponse): GraphData {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  for (const row of res.rows)
    for (const cell of row) {
      if (isRawEdge(cell)) edges.set(String(cell.id), toEdge(cell));
      else if (isRawNode(cell)) nodes.set(String(cell.id), toNode(cell));
    }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
