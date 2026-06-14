import type { GraphNode, ViewportTransform } from './graph-model';
import { worldToScreen, type Point } from './viewport';

/**
 * Return the id of the topmost node whose drawn circle (radius in screen px) contains `point`,
 * or null. Iterates in reverse so the last-drawn (topmost) node wins on overlap.
 */
export function hitTest(
  point: Point,
  nodes: GraphNode[],
  vp: ViewportTransform,
  radius: number,
): string | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.x == null || n.y == null) continue;
    const s = worldToScreen({ x: n.x, y: n.y }, vp);
    const dx = s.x - point.x;
    const dy = s.y - point.y;
    if (dx * dx + dy * dy <= radius * radius) return n.id;
  }
  return null;
}
