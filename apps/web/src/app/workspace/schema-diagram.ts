import type { SchemaSummary } from '@atlas/core';

export interface SchemaDiagramNode {
  label: string;
  count: number;
  /** Distinct property names for this label (for the box body). */
  properties: string[];
  x: number;
  y: number;
}

export interface SchemaDiagramEdge {
  type: string;
  count: number;
  fromLabel: string;
  toLabel: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  selfLoop: boolean;
}

export interface SchemaDiagram {
  nodes: SchemaDiagramNode[];
  edges: SchemaDiagramEdge[];
}

export interface Viewport {
  width: number;
  height: number;
}

/** The label with the highest frequency in a from/to distribution (or null if empty). */
function dominant(dist: Record<string, number>): string | null {
  let best: string | null = null;
  let bestN = -1;
  for (const [label, n] of Object.entries(dist))
    if (n > bestN) {
      best = label;
      bestN = n;
    }
  return best;
}

/**
 * Deterministic ring layout: label boxes evenly spaced on an ellipse inside the
 * viewport, edges connecting dominant from/to endpoints. Pure + side-effect-free
 * so it is fully unit-testable; the SVG view consumes the positioned view-model.
 */
export function buildSchemaDiagram(schema: SchemaSummary, viewport: Viewport): SchemaDiagram {
  const { width, height } = viewport;
  const cx = width / 2;
  const cy = height / 2;
  const rx = Math.max(width / 2 - 80, 0);
  const ry = Math.max(height / 2 - 60, 0);
  const n = schema.labels.length;

  const nodes: SchemaDiagramNode[] = schema.labels.map((l, i) => {
    const angle = n === 0 ? 0 : (2 * Math.PI * i) / n - Math.PI / 2;
    return {
      label: l.label,
      count: l.count,
      properties: l.properties.map((p) => p.property),
      x: n === 1 ? cx : cx + rx * Math.cos(angle),
      y: n === 1 ? cy : cy + ry * Math.sin(angle),
    };
  });

  const byLabel = new Map(nodes.map((node) => [node.label, node]));

  const edges: SchemaDiagramEdge[] = [];
  for (const e of schema.edgeTypes) {
    const fromLabel = dominant(e.from);
    const toLabel = dominant(e.to);
    if (!fromLabel || !toLabel) continue;
    const a = byLabel.get(fromLabel);
    const b = byLabel.get(toLabel);
    if (!a || !b) continue; // endpoint label not in the schema → drop
    edges.push({
      type: e.type,
      count: e.count,
      fromLabel,
      toLabel,
      fromX: a.x,
      fromY: a.y,
      toX: b.x,
      toY: b.y,
      selfLoop: fromLabel === toLabel,
    });
  }

  return { nodes, edges };
}
