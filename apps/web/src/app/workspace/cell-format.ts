/** A query-result node cell (a serialized NodeRecord — verified wire shape uses `props`). */
export interface GraphNode {
  id: number;
  labels: string[];
  props: Record<string, unknown>;
}

/** A query-result edge cell (a serialized EdgeRecord). */
export interface GraphEdge {
  id: number;
  type: string;
  from: number;
  to: number;
  props: Record<string, unknown>;
}

export function isNodeCell(v: unknown): v is GraphNode {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as GraphNode).id === 'number' &&
    Array.isArray((v as GraphNode).labels)
  );
}

export function isEdgeCell(v: unknown): v is GraphEdge {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as GraphEdge).id === 'number' &&
    typeof (v as GraphEdge).type === 'string' &&
    typeof (v as GraphEdge).from === 'number' &&
    typeof (v as GraphEdge).to === 'number'
  );
}

/** Compact human-readable cell text for the results table. */
export function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (isNodeCell(v)) {
    const label = v.labels[0] ? `:${v.labels[0]}` : '';
    const name = v.props['name'] ?? v.props['title'] ?? v.props['id'];
    return name === undefined ? `${label} {…}`.trim() : `${label} {name: ${String(name)}}`.trim();
  }
  if (isEdgeCell(v)) return `-[:${v.type}]->`;
  if (Array.isArray(v)) return `[${v.map(formatCell).join(', ')}]`;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export interface ExtractedGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  hasGraph: boolean;
}

/** Scan every cell, collecting distinct nodes/edges (by id). Powers canvas projection (Task 6). */
export function extractGraphElements(columns: string[], rows: unknown[][]): ExtractedGraph {
  const nodes = new Map<number, GraphNode>();
  const edges = new Map<number, GraphEdge>();
  for (const row of rows)
    for (const cell of row) {
      if (isNodeCell(cell)) nodes.set(cell.id, cell);
      else if (isEdgeCell(cell)) edges.set(cell.id, cell);
    }
  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    hasGraph: nodes.size > 0 || edges.size > 0,
  };
}
