import type { GraphNode, ViewportTransform } from './graph-model';

export interface Point {
  x: number;
  y: number;
}

export const IDENTITY: ViewportTransform = { k: 1, tx: 0, ty: 0 };
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;

export function worldToScreen(p: Point, vp: ViewportTransform): Point {
  return { x: p.x * vp.k + vp.tx, y: p.y * vp.k + vp.ty };
}

export function screenToWorld(p: Point, vp: ViewportTransform): Point {
  return { x: (p.x - vp.tx) / vp.k, y: (p.y - vp.ty) / vp.k };
}

export function panBy(vp: ViewportTransform, dx: number, dy: number): ViewportTransform {
  return { k: vp.k, tx: vp.tx + dx, ty: vp.ty + dy };
}

/** Zoom by `factor` about a screen-space `anchor`, keeping that anchor's world point fixed. */
export function zoomAt(vp: ViewportTransform, anchor: Point, factor: number): ViewportTransform {
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, vp.k * factor));
  // Solve so screenToWorld(anchor) is unchanged after the scale change.
  const tx = anchor.x - (anchor.x - vp.tx) * (k / vp.k);
  const ty = anchor.y - (anchor.y - vp.ty) * (k / vp.k);
  return { k, tx, ty };
}

/** Fit the nodes' bounding box into a `width × height` canvas with `padding` px around it. */
export function fitToNodes(
  nodes: GraphNode[],
  width: number,
  height: number,
  padding: number,
): ViewportTransform {
  const placed = nodes.filter((n) => n.x != null && n.y != null);
  if (placed.length === 0) return IDENTITY;
  const xs = placed.map((n) => n.x!);
  const ys = placed.map((n) => n.y!);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((width - 2 * padding) / spanX, (height - 2 * padding) / spanY)));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { k, tx: width / 2 - cx * k, ty: height / 2 - cy * k };
}
