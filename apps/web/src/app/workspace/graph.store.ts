import { computed, Injectable, signal } from '@angular/core';
import type { SchemaSummary } from '@atlas/core';
import {
  applyVisibility,
  capNodes,
  DEFAULT_RENDER_CAP,
  mergeGraph,
  NODE_RADIUS,
  type GraphData,
  type GraphEdge,
  type GraphNode,
  type Selection,
} from './graph-model';
import type { AlgorithmPaint } from './workspace-graph-store.contract';

/** Algorithm-paint palette for community/component coloring (mirrors the theme node palette). */
const PAINT_PALETTE = ['#6366f1', '#22d3ee', '#a855f7', '#f472b6', '#34d399', '#fbbf24'];
/** Radius bounds for score→size mapping (CSS px); the smallest score keeps the default radius. */
const PAINT_MIN_RADIUS = NODE_RADIUS;
const PAINT_MAX_RADIUS = NODE_RADIUS * 3;

export interface LabelEntry {
  label: string;
  count: number;
  visible: boolean;
  /** Total reported by `Database.schema()`; shown when no data of this label is loaded. */
  schemaCount?: number;
}
export interface EdgeTypeEntry {
  type: string;
  count: number;
  visible: boolean;
  /** Total reported by `Database.schema()`; shown when no data of this type is loaded. */
  schemaCount?: number;
}
export interface Connection {
  edge: GraphEdge;
  neighborId: string;
  direction: 'in' | 'out';
}

@Injectable()
export class GraphStore {
  private readonly _data = signal<GraphData>({ nodes: [], edges: [] });
  private readonly _labels = signal<LabelEntry[]>([]);
  private readonly _edgeTypes = signal<EdgeTypeEntry[]>([]);
  private readonly _selection = signal<Selection>(null);
  private readonly _renderCap = signal(DEFAULT_RENDER_CAP);

  readonly labels = this._labels.asReadonly();
  readonly edgeTypes = this._edgeTypes.asReadonly();
  readonly selection = this._selection.asReadonly();
  readonly renderCap = this._renderCap.asReadonly();

  /** Visibility derived from the legend entries (label/type hidden when its entry is not visible). */
  private readonly visibility = computed(() => ({
    hiddenLabels: new Set(
      this._labels()
        .filter((l) => !l.visible)
        .map((l) => l.label),
    ),
    hiddenTypes: new Set(
      this._edgeTypes()
        .filter((t) => !t.visible)
        .map((t) => t.type),
    ),
  }));

  /** The full filtered graph (pre-cap) — used for counts. */
  private readonly filtered = computed(() => applyVisibility(this._data(), this.visibility()));
  private readonly capped = computed(() => capNodes(this.filtered().nodes, this._renderCap()));

  readonly visibleNodes = computed(() => this.capped().visible);
  readonly visibleEdges = computed(() => {
    const present = new Set(this.capped().visible.map((n) => n.id));
    return this.filtered().edges.filter((e) => present.has(e.from) && present.has(e.to));
  });
  readonly shownCount = computed(() => this.capped().shown);
  readonly totalNodeCount = computed(() => this._data().nodes.length);
  readonly isCapped = computed(() => this.filtered().nodes.length > this._renderCap());

  readonly selectedNode = computed<GraphNode | null>(() => {
    const sel = this._selection();
    if (sel?.kind !== 'node') return null;
    return this._data().nodes.find((n) => n.id === sel.id) ?? null;
  });
  readonly selectedEdge = computed<GraphEdge | null>(() => {
    const sel = this._selection();
    if (sel?.kind !== 'edge') return null;
    return this._data().edges.find((e) => e.id === sel.id) ?? null;
  });

  ingestSchema(schema: SchemaSummary): void {
    const labels = this._labels().map((l) => ({ ...l }));
    const labelIndex = new Map(labels.map((l) => [l.label, l]));
    for (const l of schema.labels) {
      const existing = labelIndex.get(l.label);
      if (existing) {
        existing.count = l.count;
        existing.schemaCount = l.count;
      } else {
        const entry = { label: l.label, count: l.count, visible: true, schemaCount: l.count };
        labels.push(entry);
        labelIndex.set(l.label, entry);
      }
    }
    this._labels.set(labels);

    const types = this._edgeTypes().map((t) => ({ ...t }));
    const typeIndex = new Map(types.map((t) => [t.type, t]));
    for (const t of schema.edgeTypes) {
      const existing = typeIndex.get(t.type);
      if (existing) {
        existing.count = t.count;
        existing.schemaCount = t.count;
      } else {
        const entry = { type: t.type, count: t.count, visible: true, schemaCount: t.count };
        types.push(entry);
        typeIndex.set(t.type, entry);
      }
    }
    this._edgeTypes.set(types);
  }

  addGraph(incoming: GraphData): void {
    this._data.set(mergeGraph(this._data(), incoming));
    this.refreshLegendFromData();
  }

  /**
   * Replace the displayed graph with `incoming`, discarding the previously
   * loaded nodes/edges (and any selection on a now-absent element) while keeping
   * the schema-seeded legend entries. Used by the console's "project to canvas"
   * (via the workspace adapter) so projecting a result swaps the canvas rather
   * than accumulating onto whatever was already shown.
   */
  replaceGraph(incoming: GraphData): void {
    this._data.set(mergeGraph({ nodes: [], edges: [] }, incoming));
    const sel = this._selection();
    if (sel?.kind === 'node' && !this._data().nodes.some((n) => n.id === sel.id))
      this._selection.set(null);
    else if (sel?.kind === 'edge' && !this._data().edges.some((e) => e.id === sel.id))
      this._selection.set(null);
    this.refreshLegendFromData();
  }

  /** Apply layout positions (from the worker) without disturbing the legend/selection. */
  applyPositions(positions: Map<string, { x: number; y: number }>): void {
    this._data.update((d) => ({
      ...d,
      nodes: d.nodes.map((n) => {
        const p = positions.get(n.id);
        return p ? { ...n, x: p.x, y: p.y } : n;
      }),
    }));
  }

  setNodePin(id: string, pinned: boolean): void {
    this._data.update((d) => ({
      ...d,
      nodes: d.nodes.map((n) => (n.id === id ? { ...n, pinned } : n)),
    }));
  }

  removeNode(id: string): void {
    this._data.update((d) => ({
      nodes: d.nodes.filter((n) => n.id !== id),
      edges: d.edges.filter((e) => e.from !== id && e.to !== id),
    }));
    if (this._selection()?.kind === 'node' && this._selection()?.id === id)
      this._selection.set(null);
    this.refreshLegendFromData();
  }

  toggleLabel(label: string): void {
    this._labels.update((ls) =>
      ls.map((l) => (l.label === label ? { ...l, visible: !l.visible } : l)),
    );
  }
  toggleEdgeType(type: string): void {
    this._edgeTypes.update((ts) =>
      ts.map((t) => (t.type === type ? { ...t, visible: !t.visible } : t)),
    );
  }

  setRenderCap(cap: number): void {
    this._renderCap.set(Math.max(1, Math.floor(cap)));
  }

  select(selection: Selection): void {
    this._selection.set(selection);
  }

  /**
   * Apply algorithm output styling to the displayed nodes (§7.2 / Task 8): map
   * `scores` → node `size` (normalized into [PAINT_MIN_RADIUS, PAINT_MAX_RADIUS]),
   * `communities`/components → `color` (a palette bucket per community id), and
   * every node on a `paths` entry → `highlighted`. Node ids in the paint maps are
   * numeric (algorithm output); the store keys nodes by stringified id. Overrides
   * are stamped onto the node objects so they flow through to the renderer Scene.
   * Replaces any previous paint (clears first) so re-running an algorithm is clean.
   */
  applyAlgorithmPaint(paint: AlgorithmPaint): void {
    const sizeOf = makeSizeMapper(paint.scores);
    const highlighted = new Set<string>();
    for (const path of paint.paths) for (const id of path) highlighted.add(String(id));

    this._data.update((d) => ({
      ...d,
      nodes: d.nodes.map((n) => {
        const next: GraphNode = { ...n };
        delete next.size;
        delete next.color;
        delete next.highlighted;
        const numId = Number(n.id);
        const score = paint.scores.get(numId);
        if (score !== undefined) next.size = sizeOf(score);
        const community = paint.communities.get(numId);
        if (community !== undefined)
          next.color = PAINT_PALETTE[Math.abs(community) % PAINT_PALETTE.length];
        if (highlighted.has(n.id)) next.highlighted = true;
        return next;
      }),
    }));
  }

  /** Remove all per-node algorithm-paint overrides (size/color/highlight). */
  clearAlgorithmPaint(): void {
    this._data.update((d) => ({
      ...d,
      nodes: d.nodes.map((n) => {
        const next: GraphNode = { ...n };
        delete next.size;
        delete next.color;
        delete next.highlighted;
        return next;
      }),
    }));
  }

  connectionsOf(nodeId: string): Connection[] {
    const out: Connection[] = [];
    for (const e of this._data().edges) {
      if (e.from === nodeId) out.push({ edge: e, neighborId: e.to, direction: 'out' });
      else if (e.to === nodeId) out.push({ edge: e, neighborId: e.from, direction: 'in' });
    }
    return out;
  }

  /**
   * Keep the legend in sync with loaded data WITHOUT dropping schema-seeded entries that
   * have no loaded data yet. Existing entries (from `ingestSchema` or earlier loads) keep
   * their order, `visible` toggle, and `schemaCount`; their `count` updates to the live count
   * when their label/type is present in the data, or falls back to the schema total (or 0)
   * when nothing of that label/type is loaded. Newly-discovered labels/types are appended.
   */
  private refreshLegendFromData(): void {
    const data = this._data();

    const labelCounts = new Map<string, number>();
    for (const n of data.nodes)
      for (const l of n.labels) labelCounts.set(l, (labelCounts.get(l) ?? 0) + 1);
    const labels = this._labels().map((l) => ({
      ...l,
      count: labelCounts.get(l.label) ?? l.schemaCount ?? 0,
    }));
    const seenLabels = new Set(labels.map((l) => l.label));
    for (const [label, count] of labelCounts)
      if (!seenLabels.has(label)) labels.push({ label, count, visible: true });
    this._labels.set(labels);

    const typeCounts = new Map<string, number>();
    for (const e of data.edges) typeCounts.set(e.type, (typeCounts.get(e.type) ?? 0) + 1);
    const types = this._edgeTypes().map((t) => ({
      ...t,
      count: typeCounts.get(t.type) ?? t.schemaCount ?? 0,
    }));
    const seenTypes = new Set(types.map((t) => t.type));
    for (const [type, count] of typeCounts)
      if (!seenTypes.has(type)) types.push({ type, count, visible: true });
    this._edgeTypes.set(types);
  }
}

/**
 * Build a score→radius mapper that linearly maps the observed score range onto
 * [PAINT_MIN_RADIUS, PAINT_MAX_RADIUS]. When all scores are equal (or there is a
 * single score), every node gets the max radius so the paint is still visible.
 */
function makeSizeMapper(scores: Map<number, number>): (score: number) => number {
  let min = Infinity;
  let max = -Infinity;
  for (const v of scores.values()) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  return (score: number): number => {
    if (!Number.isFinite(span) || span <= 0) return PAINT_MAX_RADIUS;
    const t = (score - min) / span;
    return PAINT_MIN_RADIUS + t * (PAINT_MAX_RADIUS - PAINT_MIN_RADIUS);
  };
}
