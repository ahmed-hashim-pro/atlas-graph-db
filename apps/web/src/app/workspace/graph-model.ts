/** A renderable node. `x`/`y` are filled in by the layout simulation; `pinned` fixes a node. */
export interface GraphNode {
  id: string;
  labels: string[];
  props: Record<string, unknown>;
  x?: number;
  y?: number;
  pinned?: boolean;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: string;
  props: Record<string, unknown>;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** What the canvas selects/inspects. */
export type Selection = { kind: 'node'; id: string } | { kind: 'edge'; id: string } | null;

/** Screen↔world transform; `k` is zoom, `(tx, ty)` is the pan offset in screen px. */
export interface ViewportTransform {
  k: number;
  tx: number;
  ty: number;
}

/** Resolved colors for the renderer, sourced from the active theme's CSS custom properties. */
export interface RenderTheme {
  background: string;
  surface: string;
  border: string;
  text: string;
  textMuted: string;
  accent: string;
  edge: string;
  /** Per-label-bucket palette (`--node-1`..`--node-6`). */
  nodePalette: string[];
}

/** Everything `drawGraph` needs for one frame. */
export interface Scene {
  nodes: GraphNode[];
  edges: GraphEdge[];
  viewport: ViewportTransform;
  theme: RenderTheme;
  selection: Selection;
  /** Stable label→palette-index map so a label keeps its color across frames. */
  colorOf: (labels: string[]) => string;
}

export interface VisibilityState {
  hiddenLabels: Set<string>;
  hiddenTypes: Set<string>;
}

/** Default maximum rendered nodes; above this the canvas degrades to "showing N of M". */
export const DEFAULT_RENDER_CAP = 300;
/** Default page size for double-click expand-neighbors. */
export const DEFAULT_EXPAND_CAP = 50;
export const NODE_RADIUS = 7;

/** Union two graphs by id (last-write-wins on node props); drop edges with missing endpoints. */
export function mergeGraph(a: GraphData, b: GraphData): GraphData {
  const nodes = new Map<string, GraphNode>();
  for (const n of a.nodes) nodes.set(n.id, n);
  for (const n of b.nodes) {
    const prev = nodes.get(n.id);
    // Preserve any existing position/pin so a re-merge does not reset the layout.
    nodes.set(
      n.id,
      prev ? { ...n, x: n.x ?? prev.x, y: n.y ?? prev.y, pinned: n.pinned ?? prev.pinned } : n,
    );
  }
  const edges = new Map<string, GraphEdge>();
  for (const e of [...a.edges, ...b.edges]) edges.set(e.id, e);
  const present = new Set(nodes.keys());
  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()].filter((e) => present.has(e.from) && present.has(e.to)),
  };
}

/** Cap the rendered nodes to `max`, keeping insertion order. */
export function capNodes(
  nodes: GraphNode[],
  max: number = DEFAULT_RENDER_CAP,
): { visible: GraphNode[]; shown: number; total: number } {
  const visible = nodes.length > max ? nodes.slice(0, max) : nodes;
  return { visible, shown: visible.length, total: nodes.length };
}

/** Filter a graph by the current visibility toggles; edges with a hidden endpoint are dropped. */
export function applyVisibility(data: GraphData, vis: VisibilityState): GraphData {
  const nodes = data.nodes.filter((n) => !n.labels.some((l) => vis.hiddenLabels.has(l)));
  const present = new Set(nodes.map((n) => n.id));
  const edges = data.edges.filter(
    (e) => !vis.hiddenTypes.has(e.type) && present.has(e.from) && present.has(e.to),
  );
  return { nodes, edges };
}
