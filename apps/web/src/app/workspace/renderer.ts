import { NODE_RADIUS, type Scene } from './graph-model';
import { worldToScreen } from './viewport';

/** Draw one frame of the graph to a 2D context. Pure: no DOM, no state beyond the ctx. */
export function drawGraph(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const { viewport: vp, theme, nodes, edges, selection, colorOf } = scene;
  // Clear in logical (CSS-pixel) space so a dpr-scaled context still wipes the
  // whole surface; fall back to the backing-store size when not supplied.
  const width = scene.width ?? ctx.canvas.width;
  const height = scene.height ?? ctx.canvas.height;

  // Clear with the theme background.
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width, height);

  const pos = new Map(nodes.filter((n) => n.x != null && n.y != null).map((n) => [n.id, n]));

  // Edges first (under the nodes).
  ctx.strokeStyle = theme.edge;
  ctx.lineWidth = 1;
  for (const e of edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const s = worldToScreen({ x: a.x!, y: a.y! }, vp);
    const t = worldToScreen({ x: b.x!, y: b.y! }, vp);
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(t.x, t.y);
    ctx.stroke();
  }

  // Nodes.
  const r = NODE_RADIUS;
  for (const n of nodes) {
    if (n.x == null || n.y == null) continue;
    const s = worldToScreen({ x: n.x, y: n.y }, vp);
    ctx.beginPath();
    ctx.fillStyle = colorOf(n.labels);
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fill();
    if (n.pinned) {
      ctx.strokeStyle = theme.textMuted;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    // Selection highlight.
    if (selection?.kind === 'node' && selection.id === n.id) {
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Label text.
    const name = n.props['name'];
    if (name != null) {
      ctx.fillStyle = theme.text;
      ctx.font = '11px sans-serif';
      ctx.fillText(String(name), s.x + r + 2, s.y + 3);
    }
  }
}
