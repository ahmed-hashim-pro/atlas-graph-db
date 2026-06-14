import type { QueryResponse } from '@atlas/protocol';
import { DEFAULT_EXPAND_CAP, type GraphData, type GraphEdge, type GraphNode } from './graph-model';

/** A node value as returned in a graph-shaped query row. */
interface RawNode {
  id: string | number;
  labels?: string[];
  properties?: Record<string, unknown>;
}
/** An edge value as returned in a graph-shaped query row. */
interface RawEdge {
  id: string | number;
  type?: string;
  from?: string | number;
  to?: string | number;
  properties?: Record<string, unknown>;
}

/** Parameterized AQL to fetch a capped, paged page of a node's neighbors (both directions). */
export function neighborQuery(
  id: string,
  limit: number = DEFAULT_EXPAND_CAP,
  skip = 0,
): { query: string; params: Record<string, unknown> } {
  return {
    query:
      'MATCH (n)-[r]-(m) WHERE id(n) = $id RETURN n, r, m ORDER BY id(m) SKIP $skip LIMIT $limit',
    params: { id, limit, skip },
  };
}

function isRawNode(v: unknown): v is RawNode {
  return typeof v === 'object' && v !== null && 'id' in v && 'labels' in v;
}
function isRawEdge(v: unknown): v is RawEdge {
  return typeof v === 'object' && v !== null && 'id' in v && 'type' in v && 'from' in v && 'to' in v;
}
function toNode(raw: RawNode): GraphNode {
  return { id: String(raw.id), labels: raw.labels ?? [], props: raw.properties ?? {} };
}
function toEdge(raw: RawEdge): GraphEdge {
  return {
    id: String(raw.id),
    from: String(raw.from),
    to: String(raw.to),
    type: raw.type ?? '',
    props: raw.properties ?? {},
  };
}

/** Collect every node/edge value found in any cell of a graph-shaped result, deduped by id. */
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
