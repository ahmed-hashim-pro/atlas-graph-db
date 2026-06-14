import { InjectionToken } from '@angular/core';
import { extractGraphElements, type GraphEdge, type GraphNode } from './cell-format';

/** A graph payload the canvas can display. */
export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Algorithm output styling for the canvas (§7.2):
 * - `scores`  → node size (e.g. PageRank/degree/betweenness)
 * - `communities` → node color (Louvain/components)
 * - `paths`   → highlighted node-id sequences (shortest paths / cycles)
 */
export interface AlgorithmPaint {
  scores: Map<number, number>;
  communities: Map<number, number>;
  paths: number[][];
}

/**
 * The minimal contract M6c needs from the workspace canvas store. The console
 * "project to canvas" affordance calls `setGraph`; the algorithms view (Task 8)
 * calls `paintAlgorithmResult`. Consumers depend on WORKSPACE_GRAPH_STORE (DI
 * token), never on a concrete class — so the console/algorithms code is testable
 * with the in-memory fake and binds to the real, canvas-backed `GraphStore`
 * adapter (`GraphStoreWorkspaceAdapter`) when mounted inside the workspace.
 */
export interface WorkspaceGraphStore {
  /** Replace the displayed node/edge set (e.g. console "project to canvas"). */
  setGraph(payload: GraphPayload): void;
  /** Apply algorithm styling to the currently displayed graph. */
  paintAlgorithmResult(paint: AlgorithmPaint): void;
}

export const WORKSPACE_GRAPH_STORE = new InjectionToken<WorkspaceGraphStore>('WorkspaceGraphStore');

/** Pure projection: pull distinct node/edge cells out of a query result. */
export function resultToGraph(columns: string[], rows: unknown[][]): GraphPayload {
  const { nodes, edges } = extractGraphElements(columns, rows);
  return { nodes, edges };
}

/**
 * An in-memory implementation used by unit tests and as the default provider in
 * `app.config.ts` so the console runs in any context (e.g. before it is mounted
 * inside the workspace). Records the last paint for assertions.
 */
export class InMemoryWorkspaceGraphStore implements WorkspaceGraphStore {
  nodes: GraphNode[] = [];
  edges: GraphEdge[] = [];
  lastPaint: AlgorithmPaint | null = null;

  setGraph(payload: GraphPayload): void {
    this.nodes = payload.nodes;
    this.edges = payload.edges;
  }

  paintAlgorithmResult(paint: AlgorithmPaint): void {
    this.lastPaint = paint;
  }
}
