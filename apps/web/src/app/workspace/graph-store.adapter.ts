import { inject, Injectable } from '@angular/core';
import { GraphStore } from './graph.store';
import type { GraphData } from './graph-model';
import type {
  AlgorithmPaint,
  GraphPayload,
  WorkspaceGraphStore,
} from './workspace-graph-store.contract';

/**
 * The real, canvas-backed `WorkspaceGraphStore` over M6b's per-database
 * `GraphStore`. Provided at the workspace scope (overriding the app-wide
 * in-memory default) so the console's "project to canvas" replaces the
 * displayed graph on the actual canvas.
 *
 * The contract's `GraphPayload` carries the query-result cell shape from
 * `cell-format` (numeric ids: `GraphNode { id:number; labels; props }`,
 * `GraphEdge { id:number; type; from:number; to:number; props }`), while the
 * renderer's `GraphData` (`graph-model`) uses string ids. This adapter is the
 * single seam that bridges the two shapes (ids stringified to match how ids
 * round-trip through `GraphStore`/`parseGraphRows`).
 */
@Injectable()
export class GraphStoreWorkspaceAdapter implements WorkspaceGraphStore {
  private readonly store = inject(GraphStore);

  setGraph(payload: GraphPayload): void {
    this.store.replaceGraph(toGraphData(payload));
  }

  /**
   * Apply algorithm output styling (node size = score, color = community,
   * highlighted paths) to the canvas via the store's `applyAlgorithmPaint`, which
   * stamps per-node `size`/`color`/`highlighted` overrides honored by the renderer.
   */
  paintAlgorithmResult(paint: AlgorithmPaint): void {
    this.store.applyAlgorithmPaint(paint);
  }
}

/** Convert a numeric-id result payload (cell-format) into renderer `GraphData`. */
function toGraphData(payload: GraphPayload): GraphData {
  return {
    nodes: payload.nodes.map((n) => ({
      id: String(n.id),
      labels: n.labels,
      props: n.props,
    })),
    edges: payload.edges.map((e) => ({
      id: String(e.id),
      from: String(e.from),
      to: String(e.to),
      type: e.type,
      props: e.props,
    })),
  };
}
