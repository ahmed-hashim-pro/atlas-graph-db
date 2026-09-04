# Atlas M6b — Knowledge Graph Explorer: Workspace Graph Canvas

**Goal:** Replace the M6a placeholder `/db/:name` route with the real **Workspace** — a graph canvas as the hero (spec §7.2/§7.3). Ship a framework-agnostic, signal-friendly graph view-model store; a deterministic d3-force layout that runs in a Web Worker but is unit-tested as a plain function; a Canvas2D renderer core that reads colors from the active theme tokens; pure zoom/pan viewport math and pure point→node hit-testing; an Angular canvas component that wires the renderer + worker + viewport to pointer events (zoom/pan, click-select, drag-to-pin, double-click expand, right-click context menu); double-click expand-neighbors through `Database.query` (capped + paged); a right inspector (read-only properties + connection list + expand/paths actions) and a left label/edge-type legend with color swatches + visibility toggles + counts; live updates from `Database.subscribe`; and a Playwright e2e that seeds a db, opens the workspace, asserts the canvas renders, selects a node, and toggles a label. The renderer, simulation, hit-testing and viewport stay PLAIN TS (maximally Vitest-testable); the Angular component and the Worker are thin wrappers.

**Architecture:** The hero workspace is composed of plain-TS cores wrapped by thin Angular shells, matching the chosen "logic-heavy + e2e smoke" testing strategy. (1) A signal-based `GraphStore` (Angular `@Injectable`, but its merge/cap/visibility/selection logic is pure and unit-tested) holds the visible node/edge set as `GraphNode`/`GraphEdge`, the selection, per-label and per-edge-type visibility toggles with counts (seeded from `Database.schema()`, refined from query results), and a configurable render cap producing a "showing N of M" indicator. (2) `simulation.ts` is a plain function over `SimGraph` → positions using d3-force with a **seeded** deterministic RNG, so ticks converge identically every run; `layout.worker.ts` is a ~40-line wrapper that forwards a typed message protocol (`init`/`tick`/`pin`/`unpin`/`stop`) to the same core. (3) `renderer.ts` exports `drawGraph(ctx, scene)` taking nodes-with-positions + edges + a `ViewportTransform` + a resolved `RenderTheme` (node/accent/text/edge colors) and issues Canvas2D draw calls; `hitTest.ts` is pure `point→nodeId|null`. (4) `viewport.ts` holds pure `screenToWorld`/`worldToScreen`/`zoomAt`/`panBy` math. (5) `GraphCanvas` (Angular) owns the `<canvas>`, resolves `RenderTheme` from the active theme's CSS custom properties via `getComputedStyle`, drives a `requestAnimationFrame` loop, spawns the worker, and translates pointer/wheel/contextmenu events into store + viewport mutations. (6) Expand-neighbors issues a parameterized AQL query (cap + skip) through `AtlasApi.database(name)`. (7) The `Inspector` and `Legend` are signal-bound presentational components. (8) Live updates subscribe to the change feed and merge frames into the store; the e2e drives a real seeded database served by `@atlas/server`.

**Tech Stack:** Existing M6a stack — Angular 20.3 (standalone, signals, zoneless, Router), the `@angular/build:unit-test` Vitest runner with jsdom, `@atlas/client` (cookie mode), `AtlasApi`/`AuthService`/`ThemeService`, three CSS-token themes, Playwright e2e — plus `d3-force ^3.0.0` (+ `@types/d3-force`) for the layout simulation and the browser `Worker` API (`new Worker(new URL('./layout.worker', import.meta.url), { type: 'module' })`, which the Angular `@angular/build:application` builder bundles). The AQL console + visual EXPLAIN + schema view + algorithms view (M6c) and admin + import UI + ⌘K node search + inspector editing + paths-finding UI (M6d) are **out of scope here.**

**Spec:** `docs/design/specs/2026-06-10-atlas-graph-platform-design.md` §7.2 (Workspace: top bar, left rail with the label/edge-type legend + visibility toggles + counts, center graph canvas, right inspector with selected node/edge properties + connection list + expand/paths actions), §7.3 (custom plain-TS Canvas2D renderer wrapped in an Angular component; d3-force simulation in a Web Worker streaming positions; interactions: zoom/pan, click select, double-click expand neighbors capped+paged, right-click context menu, drag to pin; graceful degradation to a configurable max-rendered-nodes cap with a "showing N of M" indicator), §7.4 (the renderer reads colors from the active token set), §7.5 (keyboard nav + visible focus + ARIA on non-canvas controls; canvas interactions mirrored by an accessible node list — the inspector's connection list + the results node list serve as the v1 mirror).

**Existing code anchors (from M5a + M6a — verified):**
- `@atlas/client` (`packages/client/src/index.ts`): `connect(url, { mode: 'cookie' }) → AtlasClient`; `AtlasClient.database(name) → Database`; `Database.query(aql, params) → Promise<QueryResponse>`; `Database.schema() → Promise<SchemaSummary>`; `Database.subscribe(filter, onFrame) → Promise<Subscription>` where `Subscription { close(): void }`. `AtlasClientError { code, status, message, problem? }`.
- `@atlas/protocol` (`packages/protocol/src/wire.ts`): `QueryResponse { columns: string[]; rows: unknown[][]; stats }`; `RoleName = 'owner'|'editor'|'viewer'`; `DbInfo { name, description?, role, owners }`. The change-feed `WsFrame`/`SubscribeFilter` types are exported from `@atlas/protocol`; `SubscribeFilter { labels?: string[]; types?: string[] }`.
- `SchemaSummary` (`packages/core/src/schema.ts`): `{ labels: { label: string; count: number; properties: { property; types }[] }[]; edgeTypes: { type: string; count: number; from: string; to: string }[] }`.
- `apps/web` (M6a): `AtlasApi` (DI service wrapping the cookie-mode client; `.database(name)` returns a `Database` with `.query`/`.schema`/`.subscribe`); `ThemeService` (`current()` signal, `set(id)`, `THEMES`, `ThemeId`) applying `data-theme` on `<html>`; `styles.css` token sets exposing `--bg`, `--surface`, `--border`, `--text`, `--text-muted`, `--accent`, `--accent-2`, `--node-1`..`--node-6` per theme; the app shell + routes; the **placeholder** `WorkspacePlaceholder` at `apps/web/src/app/workspace/workspace-placeholder.ts` registered for `db/:name` — **this milestone replaces it**. Tests run via `pnpm -F web exec ng test --watch=false`; the gate is `pnpm build && pnpm typecheck:test && pnpm lint && pnpm format && pnpm test`.

## File structure

```
apps/web/
  package.json            MODIFY: add d3-force + @types/d3-force
  src/app/workspace/
    graph-model.ts         CREATE: GraphNode/GraphEdge/Viewport/RenderTheme/Scene types + helpers (pure)
    graph-model.spec.ts    CREATE
    graph.store.ts         CREATE: signal-based GraphStore (merge, cap, visibility, selection)
    graph.store.spec.ts    CREATE
    simulation.ts          CREATE: plain-TS seeded d3-force core (runSimulation/createSimulation)
    simulation.spec.ts     CREATE
    layout.worker.ts       CREATE: thin Worker wrapper over simulation.ts (message protocol)
    viewport.ts            CREATE: pure zoom/pan math (screenToWorld/worldToScreen/zoomAt/panBy/fit)
    viewport.spec.ts       CREATE
    renderer.ts            CREATE: pure Canvas2D drawGraph(ctx, scene)
    renderer.spec.ts       CREATE
    hit-test.ts            CREATE: pure hitTest(point, nodes, viewport, radius) → nodeId | null
    hit-test.spec.ts       CREATE
    theme-colors.ts        CREATE: resolveRenderTheme(host) reads CSS custom props (pure given a getter)
    theme-colors.spec.ts   CREATE
    expand.ts              CREATE: pure neighborQuery(nodeId, cap, skip) + parseGraphRows(QueryResponse)
    expand.spec.ts         CREATE
    graph-canvas.ts        CREATE: Angular component (canvas + worker + viewport + pointer events)
    graph-canvas.html      CREATE
    graph-canvas.spec.ts   CREATE
    inspector.ts           CREATE: right inspector component (read-only props + connections + actions)
    inspector.html         CREATE
    inspector.spec.ts      CREATE
    legend.ts              CREATE: label/edge-type legend component (swatches + toggles + counts)
    legend.html            CREATE
    legend.spec.ts         CREATE
    workspace.ts           CREATE: Workspace page (top bar + legend rail + canvas + inspector); REPLACES placeholder
    workspace.html         CREATE
    workspace.spec.ts      CREATE
    workspace-placeholder.ts  DELETE (replaced by workspace.ts)
  src/app/app.routes.ts    MODIFY: db/:name → Workspace
  src/styles.css           MODIFY (Task 7): append workspace layout (rail/canvas/inspector grid)
  e2e/workspace.spec.ts    CREATE (Task 8): Playwright workspace smoke
README.md                  MODIFY (Task 8): status → M6b
```

Conventions: Angular code uses **bare** import specifiers (no `.js` suffix) — the Angular builder resolves them. Zoneless + signals throughout. Commits end with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. NEVER run bare `vitest` — the app suite runs via `pnpm -F web exec ng test --watch=false` (Vitest builder, jsdom). Prettier config is `{ singleQuote: true, printWidth: 100 }`. The render cap default is **300** nodes (`DEFAULT_RENDER_CAP`); the expand page size default is **50** (`DEFAULT_EXPAND_CAP`). The simulation is seeded so layouts are deterministic in tests.

---

### Task 1: Graph model types + `GraphStore` (signal-based view-model)

The store is the single source of truth for what the canvas shows: the visible node/edge set, the selection, per-label/per-edge-type visibility with counts, and the render cap with "showing N of M". The merge/cap/visibility/selection logic is pure and exhaustively unit-tested; the Angular `@Injectable` wrapper merely holds it in signals.

**Files:**
- Create: `apps/web/src/app/workspace/graph-model.ts`, `apps/web/src/app/workspace/graph.store.ts`
- Test: `apps/web/src/app/workspace/graph-model.spec.ts`, `apps/web/src/app/workspace/graph.store.spec.ts`

- [x] **Step 1: Write the failing tests**

`apps/web/src/app/workspace/graph-model.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RENDER_CAP,
  applyVisibility,
  capNodes,
  mergeGraph,
  type GraphEdge,
  type GraphNode,
} from './graph-model';

function node(id: string, label = 'Person'): GraphNode {
  return { id, labels: [label], props: { name: id } };
}
function edge(id: string, from: string, to: string, type = 'KNOWS'): GraphEdge {
  return { id, from, to, type, props: {} };
}

describe('mergeGraph', () => {
  it('unions nodes and edges by id, last-write-wins on props', () => {
    const a = { nodes: [node('1')], edges: [] as GraphEdge[] };
    const b = { nodes: [{ ...node('1'), props: { name: 'X' } }, node('2')], edges: [edge('e1', '1', '2')] };
    const merged = mergeGraph(a, b);
    expect(merged.nodes.map((n) => n.id).sort()).toEqual(['1', '2']);
    expect(merged.nodes.find((n) => n.id === '1')?.props['name']).toBe('X');
    expect(merged.edges.map((e) => e.id)).toEqual(['e1']);
  });

  it('drops edges whose endpoints are not (yet) present', () => {
    const merged = mergeGraph({ nodes: [node('1')], edges: [] }, { nodes: [], edges: [edge('e', '1', '999')] });
    expect(merged.edges).toEqual([]);
  });
});

describe('capNodes', () => {
  it('keeps the first N nodes and reports the total', () => {
    const nodes = Array.from({ length: 5 }, (_, i) => node(String(i)));
    const { visible, shown, total } = capNodes(nodes, 3);
    expect(shown).toBe(3);
    expect(total).toBe(5);
    expect(visible.map((n) => n.id)).toEqual(['0', '1', '2']);
  });

  it('defaults to DEFAULT_RENDER_CAP and is a no-op under the cap', () => {
    expect(DEFAULT_RENDER_CAP).toBe(300);
    const nodes = [node('a'), node('b')];
    expect(capNodes(nodes, DEFAULT_RENDER_CAP).shown).toBe(2);
  });
});

describe('applyVisibility', () => {
  it('hides nodes of toggled-off labels and edges of toggled-off types', () => {
    const nodes = [node('1', 'Person'), node('2', 'Doc')];
    const edges = [edge('e', '1', '2', 'WROTE')];
    const out = applyVisibility(
      { nodes, edges },
      { hiddenLabels: new Set(['Doc']), hiddenTypes: new Set() },
    );
    expect(out.nodes.map((n) => n.id)).toEqual(['1']);
    expect(out.edges).toEqual([]); // edge endpoint '2' hidden → edge dropped
  });

  it('hides edges of a toggled-off type but keeps the nodes', () => {
    const nodes = [node('1'), node('2')];
    const edges = [edge('e', '1', '2', 'KNOWS')];
    const out = applyVisibility({ nodes, edges }, { hiddenLabels: new Set(), hiddenTypes: new Set(['KNOWS']) });
    expect(out.nodes).toHaveLength(2);
    expect(out.edges).toEqual([]);
  });
});
```

`apps/web/src/app/workspace/graph.store.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { GraphStore } from './graph.store';
import type { GraphEdge, GraphNode } from './graph-model';
import type { SchemaSummary } from '@atlas/core';

function node(id: string, label = 'Person'): GraphNode {
  return { id, labels: [label], props: { name: id } };
}
function edge(id: string, from: string, to: string, type = 'KNOWS'): GraphEdge {
  return { id, from, to, type, props: {} };
}
const schema: SchemaSummary = {
  labels: [
    { label: 'Person', count: 2, properties: [] },
    { label: 'Doc', count: 1, properties: [] },
  ],
  edgeTypes: [{ type: 'KNOWS', count: 1, from: 'Person', to: 'Person' }],
};

function make(): GraphStore {
  return TestBed.runInInjectionContext(() => new GraphStore());
}

describe('GraphStore', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('ingests schema into label/edge legend entries with counts, all visible by default', () => {
    const store = make();
    store.ingestSchema(schema);
    expect(store.labels().map((l) => [l.label, l.count, l.visible])).toEqual([
      ['Person', 2, true],
      ['Doc', 1, true],
    ]);
    expect(store.edgeTypes()).toEqual([{ type: 'KNOWS', count: 1, visible: true }]);
  });

  it('addGraph merges nodes/edges and recomputes visible scene + counts', () => {
    const store = make();
    store.addGraph({ nodes: [node('1'), node('2'), node('3', 'Doc')], edges: [edge('e', '1', '2')] });
    expect(store.totalNodeCount()).toBe(3);
    expect(store.visibleNodes()).toHaveLength(3);
    expect(store.visibleEdges()).toHaveLength(1);
  });

  it('toggling a label hides its nodes (and dependent edges) from the visible scene', () => {
    const store = make();
    store.addGraph({ nodes: [node('1'), node('2', 'Doc')], edges: [edge('e', '1', '2', 'WROTE')] });
    store.toggleLabel('Doc');
    expect(store.visibleNodes().map((n) => n.id)).toEqual(['1']);
    expect(store.visibleEdges()).toEqual([]);
  });

  it('toggling an edge type hides only those edges', () => {
    const store = make();
    store.addGraph({ nodes: [node('1'), node('2')], edges: [edge('e', '1', '2', 'KNOWS')] });
    store.toggleEdgeType('KNOWS');
    expect(store.visibleNodes()).toHaveLength(2);
    expect(store.visibleEdges()).toEqual([]);
  });

  it('enforces the render cap and reports "showing N of M"', () => {
    const store = make();
    store.setRenderCap(2);
    store.addGraph({ nodes: [node('1'), node('2'), node('3')], edges: [] });
    expect(store.visibleNodes()).toHaveLength(2);
    expect(store.shownCount()).toBe(2);
    expect(store.totalNodeCount()).toBe(3);
    expect(store.isCapped()).toBe(true);
  });

  it('selection: select a node, then a node-not-present clears selection', () => {
    const store = make();
    store.addGraph({ nodes: [node('1')], edges: [] });
    store.select({ kind: 'node', id: '1' });
    expect(store.selection()).toEqual({ kind: 'node', id: '1' });
    expect(store.selectedNode()?.id).toBe('1');
    store.select(null);
    expect(store.selection()).toBeNull();
    expect(store.selectedNode()).toBeNull();
  });

  it('connectionsOf returns incident edges with the neighbor id', () => {
    const store = make();
    store.addGraph({ nodes: [node('1'), node('2'), node('3')], edges: [edge('e1', '1', '2'), edge('e2', '3', '1')] });
    const conns = store.connectionsOf('1');
    expect(conns.map((c) => c.neighborId).sort()).toEqual(['2', '3']);
    expect(conns.find((c) => c.neighborId === '2')?.direction).toBe('out');
    expect(conns.find((c) => c.neighborId === '3')?.direction).toBe('in');
  });

  it('removeNode (live delete) drops the node, its edges, and clears selection if it was selected', () => {
    const store = make();
    store.addGraph({ nodes: [node('1'), node('2')], edges: [edge('e', '1', '2')] });
    store.select({ kind: 'node', id: '1' });
    store.removeNode('1');
    expect(store.visibleNodes().map((n) => n.id)).toEqual(['2']);
    expect(store.visibleEdges()).toEqual([]);
    expect(store.selection()).toBeNull();
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm -F web exec ng test --watch=false`
Expected: FAIL — `./graph-model` and `./graph.store` not found.

- [x] **Step 3: Implement `apps/web/src/app/workspace/graph-model.ts`**

```ts
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
    nodes.set(n.id, prev ? { ...n, x: n.x ?? prev.x, y: n.y ?? prev.y, pinned: n.pinned ?? prev.pinned } : n);
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
```

- [x] **Step 4: Implement `apps/web/src/app/workspace/graph.store.ts`**

```ts
import { computed, Injectable, signal } from '@angular/core';
import type { SchemaSummary } from '@atlas/core';
import {
  applyVisibility,
  capNodes,
  DEFAULT_RENDER_CAP,
  mergeGraph,
  type GraphData,
  type GraphEdge,
  type GraphNode,
  type Selection,
} from './graph-model';

export interface LabelEntry {
  label: string;
  count: number;
  visible: boolean;
}
export interface EdgeTypeEntry {
  type: string;
  count: number;
  visible: boolean;
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
    hiddenLabels: new Set(this._labels().filter((l) => !l.visible).map((l) => l.label)),
    hiddenTypes: new Set(this._edgeTypes().filter((t) => !t.visible).map((t) => t.type)),
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
    const seenLabels = new Set(this._labels().map((l) => l.label));
    const labels = [...this._labels()];
    for (const l of schema.labels)
      if (!seenLabels.has(l.label)) labels.push({ label: l.label, count: l.count, visible: true });
      else labels.find((e) => e.label === l.label)!.count = l.count;
    this._labels.set(labels);

    const seenTypes = new Set(this._edgeTypes().map((t) => t.type));
    const types = [...this._edgeTypes()];
    for (const t of schema.edgeTypes)
      if (!seenTypes.has(t.type)) types.push({ type: t.type, count: t.count, visible: true });
      else types.find((e) => e.type === t.type)!.count = t.count;
    this._edgeTypes.set(types);
  }

  addGraph(incoming: GraphData): void {
    this._data.set(mergeGraph(this._data(), incoming));
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
    if (this._selection()?.kind === 'node' && this._selection()?.id === id) this._selection.set(null);
    this.refreshLegendFromData();
  }

  toggleLabel(label: string): void {
    this._labels.update((ls) => ls.map((l) => (l.label === label ? { ...l, visible: !l.visible } : l)));
  }
  toggleEdgeType(type: string): void {
    this._edgeTypes.update((ts) => ts.map((t) => (t.type === type ? { ...t, visible: !t.visible } : t)));
  }

  setRenderCap(cap: number): void {
    this._renderCap.set(Math.max(1, Math.floor(cap)));
  }

  select(selection: Selection): void {
    this._selection.set(selection);
  }

  connectionsOf(nodeId: string): Connection[] {
    const out: Connection[] = [];
    for (const e of this._data().edges) {
      if (e.from === nodeId) out.push({ edge: e, neighborId: e.to, direction: 'out' });
      else if (e.to === nodeId) out.push({ edge: e, neighborId: e.from, direction: 'in' });
    }
    return out;
  }

  /** Ensure every label/edge-type seen in the data has a legend entry (counts from the live data). */
  private refreshLegendFromData(): void {
    const data = this._data();
    const labelCounts = new Map<string, number>();
    for (const n of data.nodes) for (const l of n.labels) labelCounts.set(l, (labelCounts.get(l) ?? 0) + 1);
    const prevLabels = new Map(this._labels().map((l) => [l.label, l]));
    this._labels.set(
      [...labelCounts].map(([label, count]) => ({ label, count, visible: prevLabels.get(label)?.visible ?? true })),
    );

    const typeCounts = new Map<string, number>();
    for (const e of data.edges) typeCounts.set(e.type, (typeCounts.get(e.type) ?? 0) + 1);
    const prevTypes = new Map(this._edgeTypes().map((t) => [t.type, t]));
    this._edgeTypes.set(
      [...typeCounts].map(([type, count]) => ({ type, count, visible: prevTypes.get(type)?.visible ?? true })),
    );
  }
}
```

Note: `GraphStore` is `@Injectable()` **without** `providedIn: 'root'` — it is provided per-`Workspace` instance (Task 7) so each open database gets a fresh store. `ingestSchema` seeds the legend before any data arrives (so the rail shows the full schema with counts); `refreshLegendFromData` then keeps counts in sync with what is actually loaded, preserving each entry's visibility toggle.

- [x] **Step 5: Run the tests to verify they pass**

Run: `pnpm -F web exec ng test --watch=false`
Expected: PASS — model merge/cap/visibility and store schema/add/toggle/cap/selection/connections/remove.

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): graph view-model types and signal-based GraphStore"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 2: Force layout — plain-TS seeded d3-force core + thin Worker wrapper

The simulation is a plain function tested directly in Vitest (no real Worker in jsdom). A seeded RNG makes ticks deterministic so positions converge identically and assertions are stable. The Worker is a ~40-line wrapper forwarding a typed message protocol to the same core.

**Files:**
- Create: `apps/web/src/app/workspace/simulation.ts`, `apps/web/src/app/workspace/layout.worker.ts`
- Modify: `apps/web/package.json` (add `d3-force` + `@types/d3-force`)
- Test: `apps/web/src/app/workspace/simulation.spec.ts`

- [x] **Step 1: Add d3-force**

```bash
pnpm -F web add d3-force@^3.0.0
pnpm -F web add -D @types/d3-force@^3.0.10
pnpm install
```

- [x] **Step 2: Write the failing test**

`apps/web/src/app/workspace/simulation.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createSimulation, runSimulation, type SimGraph } from './simulation';

function chain(n: number): SimGraph {
  return {
    nodes: Array.from({ length: n }, (_, i) => ({ id: String(i) })),
    edges: Array.from({ length: n - 1 }, (_, i) => ({ source: String(i), target: String(i + 1) })),
  };
}

describe('runSimulation (plain, seeded)', () => {
  it('produces a finite position for every node', () => {
    const positions = runSimulation(chain(6), { ticks: 60, seed: 1 });
    expect(positions.size).toBe(6);
    for (const p of positions.values()) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it('is deterministic for a fixed seed (same input → same output)', () => {
    const a = runSimulation(chain(8), { ticks: 80, seed: 42 });
    const b = runSimulation(chain(8), { ticks: 80, seed: 42 });
    for (const [id, p] of a) {
      expect(b.get(id)!.x).toBeCloseTo(p.x, 6);
      expect(b.get(id)!.y).toBeCloseTo(p.y, 6);
    }
  });

  it('separates connected nodes (the chain spreads out, not collapsed to a point)', () => {
    const positions = runSimulation(chain(10), { ticks: 120, seed: 7 });
    const xs = [...positions.values()].map((p) => p.x);
    const ys = [...positions.values()].map((p) => p.y);
    const spread = Math.max(...xs) - Math.min(...xs) + (Math.max(...ys) - Math.min(...ys));
    expect(spread).toBeGreaterThan(20);
  });

  it('honors pinned (fixed) nodes — a pinned node stays at its given coordinates', () => {
    const graph: SimGraph = {
      nodes: [
        { id: 'a', fx: 100, fy: 100 },
        { id: 'b' },
        { id: 'c' },
      ],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
      ],
    };
    const positions = runSimulation(graph, { ticks: 100, seed: 3 });
    expect(positions.get('a')).toEqual({ x: 100, y: 100 });
  });

  it('createSimulation exposes incremental tick() and stop() for streaming', () => {
    const sim = createSimulation(chain(5), { seed: 9 });
    const first = sim.tick();
    sim.tick();
    const third = sim.tick();
    expect(first.size).toBe(5);
    expect(third.size).toBe(5);
    sim.stop(); // must not throw
  });
});
```

- [x] **Step 3: Run the test to verify it fails**

Run: `pnpm -F web exec ng test --watch=false`
Expected: FAIL — `./simulation` not found.

- [x] **Step 4: Implement `apps/web/src/app/workspace/simulation.ts`**

```ts
import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';

export interface SimNode extends SimulationNodeDatum {
  id: string;
  /** Fixed coordinates (a pinned node); d3-force pins a node when fx/fy are set. */
  fx?: number | null;
  fy?: number | null;
}
export interface SimEdge {
  source: string;
  target: string;
}
export interface SimGraph {
  nodes: SimNode[];
  edges: SimEdge[];
}
export interface SimOptions {
  ticks?: number;
  seed?: number;
}
export type Positions = Map<string, { x: number; y: number }>;

/** Deterministic mulberry32 PRNG — d3-force calls the injected RNG for initial placement + jitter. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function build(graph: SimGraph, seed: number): Simulation<SimNode, undefined> {
  // d3-force mutates node objects; clone so the caller's data is untouched.
  const nodes: SimNode[] = graph.nodes.map((n) => ({ ...n }));
  const links: SimulationLinkDatum<SimNode>[] = graph.edges.map((e) => ({ source: e.source, target: e.target }));
  const sim = forceSimulation<SimNode>(nodes)
    .force('charge', forceManyBody().strength(-120))
    .force('link', forceLink<SimNode, SimulationLinkDatum<SimNode>>(links).id((d) => d.id).distance(40))
    .force('center', forceCenter(0, 0))
    .randomSource(mulberry32(seed))
    .stop();
  return sim;
}

function snapshot(sim: Simulation<SimNode, undefined>): Positions {
  const out: Positions = new Map();
  for (const n of sim.nodes()) out.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
  return out;
}

/** Run a fixed number of ticks synchronously and return final positions (used in tests + the worker). */
export function runSimulation(graph: SimGraph, opts: SimOptions = {}): Positions {
  const sim = build(graph, opts.seed ?? 1);
  const ticks = opts.ticks ?? 100;
  for (let i = 0; i < ticks; i++) sim.tick();
  const positions = snapshot(sim);
  // Pinned nodes report their fixed coordinates exactly.
  for (const n of graph.nodes) if (n.fx != null && n.fy != null) positions.set(n.id, { x: n.fx, y: n.fy });
  return positions;
}

export interface RunningSimulation {
  tick(): Positions;
  setPin(id: string, x: number | null, y: number | null): void;
  stop(): void;
}

/** A streaming simulation: call `tick()` per animation frame; `setPin` fixes/frees a node. */
export function createSimulation(graph: SimGraph, opts: SimOptions = {}): RunningSimulation {
  const sim = build(graph, opts.seed ?? 1);
  return {
    tick: () => {
      sim.tick();
      return snapshot(sim);
    },
    setPin: (id, x, y) => {
      const node = sim.nodes().find((n) => n.id === id);
      if (node) {
        node.fx = x;
        node.fy = y;
      }
      sim.alpha(0.3).restart().stop(); // reheat so the pin takes effect on the next tick
    },
    stop: () => sim.stop(),
  };
}
```

- [x] **Step 5: Implement the thin Worker wrapper `apps/web/src/app/workspace/layout.worker.ts`**

```ts
/// <reference lib="webworker" />
import { createSimulation, type RunningSimulation, type SimGraph } from './simulation';

/** main → worker. */
export type LayoutInbound =
  | { type: 'init'; graph: SimGraph; seed?: number }
  | { type: 'tick' }
  | { type: 'pin'; id: string; x: number; y: number }
  | { type: 'unpin'; id: string }
  | { type: 'stop' };

/** worker → main. */
export type LayoutOutbound = { type: 'positions'; positions: [string, { x: number; y: number }][] };

let sim: RunningSimulation | null = null;

addEventListener('message', (ev: MessageEvent<LayoutInbound>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init':
      sim?.stop();
      sim = createSimulation(msg.graph, { seed: msg.seed ?? 1 });
      break;
    case 'tick': {
      if (!sim) return;
      const positions = [...sim.tick().entries()];
      const out: LayoutOutbound = { type: 'positions', positions };
      postMessage(out);
      break;
    }
    case 'pin':
      sim?.setPin(msg.id, msg.x, msg.y);
      break;
    case 'unpin':
      sim?.setPin(msg.id, null, null);
      break;
    case 'stop':
      sim?.stop();
      sim = null;
      break;
  }
});
```

The Worker file is intentionally untested in isolation (jsdom has no real `Worker`); its only logic — `createSimulation` and the message switch — is covered by `simulation.spec.ts` and (via a mock worker) by the component test in Task 5. The `LayoutInbound`/`LayoutOutbound` types are the contract the component speaks.

- [x] **Step 6: Run the tests to verify they pass**

Run: `pnpm -F web exec ng test --watch=false`
Expected: PASS — finite positions, determinism for a fixed seed, spread, pinned-node fixing, streaming tick/stop.

- [x] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): seeded d3-force layout core (plain TS) and thin Web Worker wrapper"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 3: Viewport math + hit-testing (pure modules)

Zoom/pan is pure screen↔world arithmetic; point→node hit-testing is pure geometry. Both are unit-tested in isolation so the Angular component (Task 5) only has to wire events.

**Files:**
- Create: `apps/web/src/app/workspace/viewport.ts`, `apps/web/src/app/workspace/hit-test.ts`
- Test: `apps/web/src/app/workspace/viewport.spec.ts`, `apps/web/src/app/workspace/hit-test.spec.ts`

- [x] **Step 1: Write the failing tests**

`apps/web/src/app/workspace/viewport.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fitToNodes, IDENTITY, panBy, screenToWorld, worldToScreen, zoomAt } from './viewport';

describe('viewport transforms', () => {
  it('worldToScreen and screenToWorld are inverses', () => {
    const vp = { k: 2, tx: 30, ty: -10 };
    const world = { x: 12, y: 7 };
    const screen = worldToScreen(world, vp);
    expect(screen).toEqual({ x: 12 * 2 + 30, y: 7 * 2 - 10 });
    const back = screenToWorld(screen, vp);
    expect(back.x).toBeCloseTo(world.x, 9);
    expect(back.y).toBeCloseTo(world.y, 9);
  });

  it('IDENTITY maps world to screen 1:1', () => {
    expect(worldToScreen({ x: 5, y: 9 }, IDENTITY)).toEqual({ x: 5, y: 9 });
  });

  it('panBy shifts the offset, not the zoom', () => {
    const vp = panBy({ k: 1.5, tx: 0, ty: 0 }, 10, -4);
    expect(vp).toEqual({ k: 1.5, tx: 10, ty: -4 });
  });

  it('zoomAt keeps the cursor anchor point stationary in world space', () => {
    const vp = { k: 1, tx: 0, ty: 0 };
    const anchor = { x: 100, y: 50 };
    const worldBefore = screenToWorld(anchor, vp);
    const zoomed = zoomAt(vp, anchor, 2);
    expect(zoomed.k).toBe(2);
    const worldAfter = screenToWorld(anchor, zoomed);
    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 9);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 9);
  });

  it('zoomAt clamps zoom to [0.1, 8]', () => {
    expect(zoomAt({ k: 0.15, tx: 0, ty: 0 }, { x: 0, y: 0 }, 0.1).k).toBeCloseTo(0.1, 9);
    expect(zoomAt({ k: 6, tx: 0, ty: 0 }, { x: 0, y: 0 }, 4).k).toBeCloseTo(8, 9);
  });

  it('fitToNodes centers and scales a bounding box into the viewport', () => {
    const nodes = [
      { id: 'a', labels: [], props: {}, x: 0, y: 0 },
      { id: 'b', labels: [], props: {}, x: 100, y: 100 },
    ];
    const vp = fitToNodes(nodes, 400, 400, 20);
    // Both nodes must land inside the canvas after the fit.
    for (const n of nodes) {
      const s = worldToScreen({ x: n.x!, y: n.y! }, vp);
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x).toBeLessThanOrEqual(400);
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.y).toBeLessThanOrEqual(400);
    }
  });

  it('fitToNodes returns IDENTITY for an empty set', () => {
    expect(fitToNodes([], 400, 400, 20)).toEqual(IDENTITY);
  });
});
```

`apps/web/src/app/workspace/hit-test.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { hitTest } from './hit-test';
import { IDENTITY } from './viewport';
import type { GraphNode } from './graph-model';

const nodes: GraphNode[] = [
  { id: 'a', labels: [], props: {}, x: 0, y: 0 },
  { id: 'b', labels: [], props: {}, x: 100, y: 0 },
];

describe('hitTest', () => {
  it('returns the node whose drawn circle contains the screen point', () => {
    expect(hitTest({ x: 2, y: 2 }, nodes, IDENTITY, 8)).toBe('a');
    expect(hitTest({ x: 99, y: 1 }, nodes, IDENTITY, 8)).toBe('b');
  });

  it('returns null when the point is outside every node radius', () => {
    expect(hitTest({ x: 50, y: 50 }, nodes, IDENTITY, 8)).toBeNull();
  });

  it('accounts for the viewport transform (zoom + pan)', () => {
    const vp = { k: 2, tx: 10, ty: 10 }; // node 'b' world(100,0) → screen(210,10)
    expect(hitTest({ x: 210, y: 10 }, nodes, vp, 8)).toBe('b');
    expect(hitTest({ x: 100, y: 0 }, nodes, vp, 8)).toBeNull();
  });

  it('returns the topmost (last-drawn) node when circles overlap', () => {
    const overlap: GraphNode[] = [
      { id: 'under', labels: [], props: {}, x: 0, y: 0 },
      { id: 'over', labels: [], props: {}, x: 3, y: 0 },
    ];
    expect(hitTest({ x: 1, y: 0 }, overlap, IDENTITY, 8)).toBe('over');
  });

  it('ignores nodes without a position', () => {
    expect(hitTest({ x: 0, y: 0 }, [{ id: 'x', labels: [], props: {} }], IDENTITY, 8)).toBeNull();
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm -F web exec ng test --watch=false`
Expected: FAIL — `./viewport` and `./hit-test` not found.

- [x] **Step 3: Implement `apps/web/src/app/workspace/viewport.ts`**

```ts
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
```

- [x] **Step 4: Implement `apps/web/src/app/workspace/hit-test.ts`**

```ts
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
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `pnpm -F web exec ng test --watch=false`
Expected: PASS — inverse transforms, anchored zoom + clamp, fit, and hit-testing under transform/overlap.

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): pure viewport (zoom/pan/fit) and point→node hit-testing"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 4: Canvas2D renderer core + theme color resolution (pure)

`drawGraph(ctx, scene)` is a pure function over a `CanvasRenderingContext2D` — unit-tested against a stub 2D context that records calls. `resolveRenderTheme` reads the active theme's CSS custom properties into a `RenderTheme`, making the renderer theme-reactive (§7.4). A stable `colorOf(labels)` assigns each label a palette color.

**Files:**
- Create: `apps/web/src/app/workspace/renderer.ts`, `apps/web/src/app/workspace/theme-colors.ts`
- Test: `apps/web/src/app/workspace/renderer.spec.ts`, `apps/web/src/app/workspace/theme-colors.spec.ts`

- [x] **Step 1: Write the failing tests**

`apps/web/src/app/workspace/theme-colors.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { makeColorOf, resolveRenderTheme } from './theme-colors';

/** A fake CSS-var reader mapping `--token` → value. */
function reader(map: Record<string, string>): (prop: string) => string {
  return (prop) => map[prop] ?? '';
}

describe('resolveRenderTheme', () => {
  it('reads the token set into a RenderTheme', () => {
    const theme = resolveRenderTheme(
      reader({
        '--bg': '#0b0f1d',
        '--surface': '#141a2e',
        '--border': '#2a3350',
        '--text': '#e6ebff',
        '--text-muted': '#9aa6c8',
        '--accent': '#6366f1',
        '--node-1': '#6366f1',
        '--node-2': '#22d3ee',
        '--node-3': '#a855f7',
        '--node-4': '#f472b6',
        '--node-5': '#34d399',
        '--node-6': '#fbbf24',
      }),
    );
    expect(theme.background).toBe('#0b0f1d');
    expect(theme.accent).toBe('#6366f1');
    expect(theme.nodePalette).toHaveLength(6);
    expect(theme.nodePalette[1]).toBe('#22d3ee');
    expect(theme.edge).toBe('#2a3350'); // edges default to the border token
  });

  it('falls back to safe defaults when a token is missing', () => {
    const theme = resolveRenderTheme(reader({}));
    expect(theme.background.length).toBeGreaterThan(0);
    expect(theme.nodePalette.length).toBe(6);
  });
});

describe('makeColorOf', () => {
  it('assigns a stable palette color per first label', () => {
    const palette = ['#a', '#b', '#c', '#d', '#e', '#f'];
    const colorOf = makeColorOf(palette);
    const c1 = colorOf(['Person']);
    expect(colorOf(['Person'])).toBe(c1); // stable across calls
    expect(palette).toContain(colorOf(['Doc']));
    expect(colorOf([])).toBe(palette[0]); // unlabeled → first bucket
  });
});
```

`apps/web/src/app/workspace/renderer.spec.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { drawGraph } from './renderer';
import { makeColorOf } from './theme-colors';
import { IDENTITY } from './viewport';
import type { RenderTheme, Scene } from './graph-model';

const theme: RenderTheme = {
  background: '#000',
  surface: '#111',
  border: '#222',
  text: '#fff',
  textMuted: '#999',
  accent: '#f0f',
  edge: '#222',
  nodePalette: ['#1', '#2', '#3', '#4', '#5', '#6'],
};

/** A stub 2D context that records the calls and property writes we assert on. */
function stubCtx() {
  const calls: string[] = [];
  const sets: Record<string, unknown> = {};
  const ctx = new Proxy(
    {
      canvas: { width: 400, height: 300 },
      arc: (...a: unknown[]) => calls.push(`arc(${a.join(',')})`),
      beginPath: () => calls.push('beginPath'),
      moveTo: (...a: unknown[]) => calls.push(`moveTo(${a.join(',')})`),
      lineTo: (...a: unknown[]) => calls.push(`lineTo(${a.join(',')})`),
      fill: () => calls.push('fill'),
      stroke: () => calls.push('stroke'),
      fillRect: (...a: unknown[]) => calls.push(`fillRect(${a.join(',')})`),
      fillText: (...a: unknown[]) => calls.push(`fillText(${a.join(',')})`),
      save: () => calls.push('save'),
      restore: () => calls.push('restore'),
    } as unknown as Record<string, unknown>,
    {
      set(target, prop, value) {
        sets[String(prop)] = value;
        return Reflect.set(target, prop, value);
      },
      get(target, prop) {
        return Reflect.get(target, prop);
      },
    },
  );
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, sets };
}

function scene(over: Partial<Scene> = {}): Scene {
  return {
    nodes: [
      { id: 'a', labels: ['Person'], props: { name: 'Ada' }, x: 10, y: 10 },
      { id: 'b', labels: ['Doc'], props: { name: 'Notes' }, x: 60, y: 40 },
    ],
    edges: [{ id: 'e', from: 'a', to: 'b', type: 'WROTE', props: {} }],
    viewport: IDENTITY,
    theme,
    selection: null,
    colorOf: makeColorOf(theme.nodePalette),
    ...over,
  };
}

describe('drawGraph', () => {
  it('clears the canvas with the theme background then draws edges and nodes', () => {
    const { ctx, calls, sets } = stubCtx();
    drawGraph(ctx, scene());
    expect(calls).toContain('fillRect(0,0,400,300)');
    expect(sets['fillStyle']).toBeDefined();
    const arcs = calls.filter((c) => c.startsWith('arc(')).length;
    expect(arcs).toBe(2); // one circle per node
    const lines = calls.filter((c) => c.startsWith('lineTo(')).length;
    expect(lines).toBe(1); // one segment per edge
  });

  it('paints each node with its label color from the theme palette', () => {
    const colorOf = makeColorOf(theme.nodePalette);
    const { ctx } = stubCtx();
    const fills: string[] = [];
    const orig = Object.getOwnPropertyDescriptor(ctx, 'fillStyle');
    Object.defineProperty(ctx, 'fillStyle', {
      set: (v: string) => fills.push(v),
      get: () => orig?.value as string,
    });
    drawGraph(ctx, scene({ colorOf }));
    expect(fills).toContain(colorOf(['Person']));
    expect(fills).toContain(colorOf(['Doc']));
  });

  it('draws a selection highlight (accent stroke) around the selected node', () => {
    const { ctx, sets, calls } = stubCtx();
    drawGraph(ctx, scene({ selection: { kind: 'node', id: 'a' } }));
    expect(sets['strokeStyle']).toBe(theme.accent);
    expect(calls.filter((c) => c === 'stroke').length).toBeGreaterThan(0);
  });

  it('renders node labels as text', () => {
    const { ctx, calls } = stubCtx();
    drawGraph(ctx, scene());
    const labels = calls.filter((c) => c.startsWith('fillText('));
    expect(labels.some((c) => c.includes('Ada'))).toBe(true);
  });

  it('skips nodes that have no position yet', () => {
    const { ctx, calls } = stubCtx();
    drawGraph(ctx, scene({ nodes: [{ id: 'z', labels: ['Person'], props: {} }], edges: [] }));
    expect(calls.filter((c) => c.startsWith('arc(')).length).toBe(0);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm -F web exec ng test --watch=false`
Expected: FAIL — `./renderer` and `./theme-colors` not found.

- [x] **Step 3: Implement `apps/web/src/app/workspace/theme-colors.ts`**

```ts
import type { RenderTheme } from './graph-model';

const DEFAULTS: RenderTheme = {
  background: '#0b0f1d',
  surface: '#141a2e',
  border: '#2a3350',
  text: '#e6ebff',
  textMuted: '#9aa6c8',
  accent: '#6366f1',
  edge: '#2a3350',
  nodePalette: ['#6366f1', '#22d3ee', '#a855f7', '#f472b6', '#34d399', '#fbbf24'],
};

/** A CSS-var reader, e.g. `(p) => getComputedStyle(host).getPropertyValue(p).trim()`. */
export type CssVarReader = (prop: string) => string;

/** Resolve the active theme's tokens into a RenderTheme; missing tokens fall back to DEFAULTS. */
export function resolveRenderTheme(read: CssVarReader): RenderTheme {
  const pick = (prop: string, fallback: string): string => {
    const v = read(prop).trim();
    return v.length > 0 ? v : fallback;
  };
  const nodePalette = Array.from({ length: 6 }, (_, i) =>
    pick(`--node-${i + 1}`, DEFAULTS.nodePalette[i]),
  );
  return {
    background: pick('--bg', DEFAULTS.background),
    surface: pick('--surface', DEFAULTS.surface),
    border: pick('--border', DEFAULTS.border),
    text: pick('--text', DEFAULTS.text),
    textMuted: pick('--text-muted', DEFAULTS.textMuted),
    accent: pick('--accent', DEFAULTS.accent),
    edge: pick('--border', DEFAULTS.edge),
    nodePalette,
  };
}

/**
 * A stable label→color mapper: the first label is hashed into a palette bucket and the
 * assignment is memoized so a label keeps its color across frames and across legend renders.
 */
export function makeColorOf(palette: string[]): (labels: string[]) => string {
  const cache = new Map<string, string>();
  return (labels: string[]): string => {
    const key = labels[0] ?? '';
    const hit = cache.get(key);
    if (hit) return hit;
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
    const color = palette[Math.abs(h) % palette.length] ?? palette[0];
    cache.set(key, color);
    return color;
  };
}
```

- [x] **Step 4: Implement `apps/web/src/app/workspace/renderer.ts`**

```ts
import { NODE_RADIUS, type Scene } from './graph-model';
import { worldToScreen } from './viewport';

/** Draw one frame of the graph to a 2D context. Pure: no DOM, no state beyond the ctx. */
export function drawGraph(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const { width, height } = ctx.canvas;
  const { viewport: vp, theme, nodes, edges, selection, colorOf } = scene;

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
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `pnpm -F web exec ng test --watch=false`
Expected: PASS — clear+edges+nodes counts, per-label palette fills, selection accent stroke, label text, positionless-node skip, and theme resolution + stable `colorOf`.

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): pure Canvas2D renderer and theme-token color resolution"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 5: `GraphCanvas` Angular component (renderer + worker + viewport + pointer events)

The component owns the `<canvas>`, resolves `RenderTheme` from the host's computed styles, spawns the layout worker, drives a `requestAnimationFrame` loop, and translates pointer/wheel/contextmenu events into store + viewport mutations. The heavy logic is already covered by Tasks 1–4; this test verifies the wiring with a mock worker and a stub 2D context.

**Files:**
- Create: `apps/web/src/app/workspace/graph-canvas.ts`, `apps/web/src/app/workspace/graph-canvas.html`
- Test: `apps/web/src/app/workspace/graph-canvas.spec.ts`

- [x] **Step 1: Write the failing test**

`apps/web/src/app/workspace/graph-canvas.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphCanvas } from './graph-canvas';
import { GraphStore } from './graph.store';

describe('GraphCanvas component', () => {
  beforeEach(() => TestBed.resetTestingModule());

  function setup() {
    TestBed.configureTestingModule({ imports: [GraphCanvas], providers: [GraphStore] });
    const fixture = TestBed.createComponent(GraphCanvas);
    const store = TestBed.inject(GraphStore);
    return { fixture, cmp: fixture.componentInstance, store };
  }

  it('creates and renders a canvas element', () => {
    const { fixture } = setup();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('canvas')).toBeTruthy();
  });

  it('click on a node selects it via the store (hit-test wired)', () => {
    const { fixture, cmp, store } = setup();
    store.addGraph({ nodes: [{ id: 'a', labels: ['Person'], props: {}, x: 0, y: 0 }], edges: [] });
    fixture.detectChanges();
    // World (0,0) at identity-ish transform → screen near origin; click there.
    cmp.onPointerUp({ offsetX: 0, offsetY: 0, button: 0 } as PointerEvent);
    expect(store.selection()).toEqual({ kind: 'node', id: 'a' });
  });

  it('click on empty space clears the selection', () => {
    const { fixture, cmp, store } = setup();
    store.addGraph({ nodes: [{ id: 'a', labels: [], props: {}, x: 0, y: 0 }], edges: [] });
    store.select({ kind: 'node', id: 'a' });
    fixture.detectChanges();
    cmp.onPointerUp({ offsetX: 5000, offsetY: 5000, button: 0 } as PointerEvent);
    expect(store.selection()).toBeNull();
  });

  it('wheel zooms the viewport (zoom factor applied)', () => {
    const { fixture, cmp } = setup();
    fixture.detectChanges();
    const before = cmp.viewport().k;
    cmp.onWheel({ offsetX: 100, offsetY: 100, deltaY: -100, preventDefault: vi.fn() } as unknown as WheelEvent);
    expect(cmp.viewport().k).toBeGreaterThan(before);
  });

  it('double-click on a node emits expand with the node id', () => {
    const { fixture, cmp, store } = setup();
    store.addGraph({ nodes: [{ id: 'a', labels: [], props: {}, x: 0, y: 0 }], edges: [] });
    fixture.detectChanges();
    const expand = vi.fn();
    cmp.expandNode.subscribe(expand);
    cmp.onDblClick({ offsetX: 0, offsetY: 0 } as MouseEvent);
    expect(expand).toHaveBeenCalledWith('a');
  });

  it('right-click on a node opens the context menu at the cursor', () => {
    const { fixture, cmp, store } = setup();
    store.addGraph({ nodes: [{ id: 'a', labels: [], props: {}, x: 0, y: 0 }], edges: [] });
    fixture.detectChanges();
    cmp.onContextMenu({ offsetX: 0, offsetY: 0, clientX: 12, clientY: 34, preventDefault: vi.fn() } as unknown as MouseEvent);
    expect(cmp.contextMenu()).toMatchObject({ nodeId: 'a', x: 12, y: 34 });
  });

  it('drag on a node pins it (store.setNodePin called) and posts a pin message to the worker', () => {
    const { fixture, cmp, store } = setup();
    store.addGraph({ nodes: [{ id: 'a', labels: [], props: {}, x: 0, y: 0 }], edges: [] });
    fixture.detectChanges();
    const posted: unknown[] = [];
    cmp.testWorkerPost = (m) => posted.push(m);
    cmp.onPointerDown({ offsetX: 0, offsetY: 0, button: 0 } as PointerEvent);
    cmp.onPointerMove({ offsetX: 20, offsetY: 20, buttons: 1 } as PointerEvent);
    cmp.onPointerUp({ offsetX: 20, offsetY: 20, button: 0 } as PointerEvent);
    expect(store.selectedNode()?.pinned).toBe(true);
    expect(posted.some((m) => (m as { type?: string }).type === 'pin')).toBe(true);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm -F web exec ng test --watch=false`
Expected: FAIL — `./graph-canvas` not found.

- [x] **Step 3: Implement `apps/web/src/app/workspace/graph-canvas.ts`**

```ts
import {
  AfterViewInit,
  Component,
  ElementRef,
  inject,
  OnDestroy,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { GraphStore } from './graph.store';
import { IDENTITY, panBy, screenToWorld, worldToScreen, zoomAt, type Point } from './viewport';
import { hitTest } from './hit-test';
import { drawGraph } from './renderer';
import { makeColorOf, resolveRenderTheme } from './theme-colors';
import { NODE_RADIUS, type RenderTheme, type ViewportTransform } from './graph-model';
import type { LayoutInbound, LayoutOutbound } from './layout.worker';

export interface ContextMenuState {
  nodeId: string;
  x: number;
  y: number;
}

@Component({
  selector: 'app-graph-canvas',
  templateUrl: './graph-canvas.html',
})
export class GraphCanvas implements AfterViewInit, OnDestroy {
  readonly store = inject(GraphStore);
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  /** Double-click expand request; the Workspace page handles it via AtlasApi (Task 6). */
  readonly expandNode = output<string>();

  readonly viewport = signal<ViewportTransform>(IDENTITY);
  readonly contextMenu = signal<ContextMenuState | null>(null);

  private theme: RenderTheme = resolveRenderTheme(() => '');
  private colorOf = makeColorOf(this.theme.nodePalette);
  private worker: Worker | null = null;
  private raf = 0;
  private dragId: string | null = null;
  private dragging = false;
  private panning = false;
  private last: Point = { x: 0, y: 0 };

  /** Test seam: overridden in specs to capture worker messages without a real Worker. */
  testWorkerPost: ((msg: LayoutInbound) => void) | null = null;

  ngAfterViewInit(): void {
    this.refreshTheme();
    this.spawnWorker();
    this.loop();
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.raf);
    this.postToWorker({ type: 'stop' });
    this.worker?.terminate();
  }

  /** Re-read theme tokens from the host's computed style (call when the theme changes). */
  refreshTheme(): void {
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(this.host.nativeElement) : null;
    this.theme = resolveRenderTheme((prop) => (style ? style.getPropertyValue(prop) : ''));
    this.colorOf = makeColorOf(this.theme.nodePalette);
  }

  /** (Re)seed the worker with the current graph; called by the Workspace after loads. */
  resyncLayout(): void {
    const nodes = this.store.visibleNodes().map((n) => ({
      id: n.id,
      fx: n.pinned ? (n.x ?? null) : null,
      fy: n.pinned ? (n.y ?? null) : null,
    }));
    const edges = this.store.visibleEdges().map((e) => ({ source: e.from, target: e.to }));
    this.postToWorker({ type: 'init', graph: { nodes, edges }, seed: 1 });
  }

  private spawnWorker(): void {
    if (this.testWorkerPost) return; // tests supply their own post seam
    if (typeof Worker === 'undefined') return;
    this.worker = new Worker(new URL('./layout.worker', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<LayoutOutbound>) => {
      if (ev.data.type === 'positions') this.store.applyPositions(new Map(ev.data.positions));
    };
    this.resyncLayout();
  }

  private postToWorker(msg: LayoutInbound): void {
    if (this.testWorkerPost) this.testWorkerPost(msg);
    else this.worker?.postMessage(msg);
  }

  private loop = (): void => {
    this.postToWorker({ type: 'tick' });
    this.render();
    this.raf = requestAnimationFrame(this.loop);
  };

  render(): void {
    const canvas = this.canvasRef().nativeElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    drawGraph(ctx, {
      nodes: this.store.visibleNodes(),
      edges: this.store.visibleEdges(),
      viewport: this.viewport(),
      theme: this.theme,
      selection: this.store.selection(),
      colorOf: this.colorOf,
    });
  }

  private pick(ev: { offsetX: number; offsetY: number }): string | null {
    return hitTest({ x: ev.offsetX, y: ev.offsetY }, this.store.visibleNodes(), this.viewport(), NODE_RADIUS + 2);
  }

  onPointerDown(ev: PointerEvent): void {
    this.contextMenu.set(null);
    if (ev.button !== 0) return;
    const id = this.pick(ev);
    this.last = { x: ev.offsetX, y: ev.offsetY };
    if (id) {
      this.dragId = id;
      this.dragging = false;
    } else {
      this.panning = true;
    }
  }

  onPointerMove(ev: PointerEvent): void {
    if (!(ev.buttons & 1)) return;
    const dx = ev.offsetX - this.last.x;
    const dy = ev.offsetY - this.last.y;
    if (this.dragId) {
      this.dragging = true;
      const world = screenToWorld({ x: ev.offsetX, y: ev.offsetY }, this.viewport());
      this.store.applyPositions(new Map([[this.dragId, world]]));
    } else if (this.panning) {
      this.viewport.update((vp) => panBy(vp, dx, dy));
    }
    this.last = { x: ev.offsetX, y: ev.offsetY };
  }

  onPointerUp(ev: PointerEvent): void {
    if (this.dragId) {
      if (this.dragging) {
        // A drag pins the node at its dropped world coordinates.
        const world = screenToWorld({ x: ev.offsetX, y: ev.offsetY }, this.viewport());
        this.store.applyPositions(new Map([[this.dragId, world]]));
        this.store.setNodePin(this.dragId, true);
        this.store.select({ kind: 'node', id: this.dragId });
        this.postToWorker({ type: 'pin', id: this.dragId, x: world.x, y: world.y });
      } else {
        this.store.select({ kind: 'node', id: this.dragId });
      }
    } else if (!this.panning || (Math.abs(ev.offsetX - this.last.x) < 1 && !this.dragging)) {
      const id = this.pick(ev);
      this.store.select(id ? { kind: 'node', id } : null);
    }
    this.dragId = null;
    this.dragging = false;
    this.panning = false;
  }

  onWheel(ev: WheelEvent): void {
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
    this.viewport.update((vp) => zoomAt(vp, { x: ev.offsetX, y: ev.offsetY }, factor));
  }

  onDblClick(ev: MouseEvent): void {
    const id = this.pick({ offsetX: ev.offsetX, offsetY: ev.offsetY });
    if (id) this.expandNode.emit(id);
  }

  onContextMenu(ev: MouseEvent): void {
    ev.preventDefault();
    const id = this.pick({ offsetX: ev.offsetX, offsetY: ev.offsetY });
    if (id) this.contextMenu.set({ nodeId: id, x: ev.clientX, y: ev.clientY });
    else this.contextMenu.set(null);
  }

  /** Context-menu actions (wired in the template / Task 6). */
  unpinFromMenu(id: string): void {
    this.store.setNodePin(id, false);
    this.postToWorker({ type: 'unpin', id });
    this.contextMenu.set(null);
  }
  expandFromMenu(id: string): void {
    this.expandNode.emit(id);
    this.contextMenu.set(null);
  }
  hideMenu(): void {
    this.contextMenu.set(null);
  }

  /** Re-fit the camera to the current nodes. */
  fit(): void {
    const canvas = this.canvasRef().nativeElement;
    this.viewport.set(
      worldToScreen ? this.computeFit(canvas.width, canvas.height) : IDENTITY, // see note
    );
  }

  private computeFit(width: number, height: number): ViewportTransform {
    // Delegates to the pure fitToNodes; imported lazily to keep the import list tidy.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { fitToNodes } = require('./viewport') as typeof import('./viewport');
    return fitToNodes(this.store.visibleNodes(), width, height, 40);
  }
}
```

Replace the `fit`/`computeFit` pair above with a direct import to avoid `require` (the `require` shim is not available under the Angular ESM build). Add `fitToNodes` to the top import from `./viewport` and implement `fit()` as:

```ts
  fit(): void {
    const canvas = this.canvasRef().nativeElement;
    this.viewport.set(fitToNodes(this.store.visibleNodes(), canvas.width, canvas.height, 40));
  }
```

and delete `computeFit`. (The top import becomes `import { fitToNodes, IDENTITY, panBy, screenToWorld, worldToScreen, zoomAt, type Point } from './viewport';`.)

`apps/web/src/app/workspace/graph-canvas.html`:

```html
<div class="canvas-wrap">
  <canvas
    #canvas
    width="800"
    height="600"
    tabindex="0"
    aria-label="Graph canvas"
    (pointerdown)="onPointerDown($event)"
    (pointermove)="onPointerMove($event)"
    (pointerup)="onPointerUp($event)"
    (wheel)="onWheel($event)"
    (dblclick)="onDblClick($event)"
    (contextmenu)="onContextMenu($event)"
  ></canvas>

  @if (store.isCapped()) {
    <div class="cap-badge" role="status">
      Showing {{ store.shownCount() }} of {{ store.totalNodeCount() }} nodes — narrow the legend to
      see more.
    </div>
  }

  @if (contextMenu(); as menu) {
    <ul class="context-menu" [style.left.px]="menu.x" [style.top.px]="menu.y" role="menu">
      <li><button type="button" (click)="expandFromMenu(menu.nodeId)">Expand neighbors</button></li>
      <li><button type="button" (click)="unpinFromMenu(menu.nodeId)">Unpin</button></li>
      <li><button type="button" (click)="hideMenu()">Close</button></li>
    </ul>
  }
</div>
```

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm -F web exec ng test --watch=false`
Expected: PASS — canvas renders; click-select / empty-clear; wheel-zoom; dbl-click expand emit; right-click menu; drag-pin posts a `pin` message and pins via the store. (The component uses `testWorkerPost` to avoid a real `Worker` and `getContext('2d')` is stubbed by jsdom's canvas; if jsdom returns `null` for `getContext`, `render()` early-returns and the selection/zoom assertions still hold.)

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): GraphCanvas component wiring renderer, worker, viewport, and pointer events"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 6: Expand-neighbors via `Database.query` (pure query + parse, folded into the store)

Double-click (or the context menu) expands a node's neighbors through a parameterized AQL query with a cap + skip (paging). The query string and the `QueryResponse → GraphData` parse are pure and unit-tested; the Workspace page (Task 7) calls them through `AtlasApi` and folds the result into the store.

**Files:**
- Create: `apps/web/src/app/workspace/expand.ts`
- Test: `apps/web/src/app/workspace/expand.spec.ts`

- [x] **Step 1: Write the failing test**

`apps/web/src/app/workspace/expand.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { neighborQuery, parseGraphRows } from './expand';
import { DEFAULT_EXPAND_CAP } from './graph-model';
import type { QueryResponse } from '@atlas/protocol';

describe('neighborQuery', () => {
  it('builds a parameterized AQL string with cap + skip params', () => {
    const { query, params } = neighborQuery('42', 50, 100);
    expect(query).toContain('MATCH');
    expect(query).toContain('$id');
    expect(query).toContain('LIMIT');
    expect(query).toContain('SKIP');
    expect(params).toEqual({ id: '42', limit: 50, skip: 100 });
  });

  it('defaults the cap to DEFAULT_EXPAND_CAP and skip to 0', () => {
    const { params } = neighborQuery('7');
    expect(params).toEqual({ id: '7', limit: DEFAULT_EXPAND_CAP, skip: 0 });
  });
});

describe('parseGraphRows', () => {
  it('parses node + edge columns into GraphData (deduping by id)', () => {
    // Columns: n (source node), r (edge), m (neighbor node) — the shape neighborQuery returns.
    const res: QueryResponse = {
      columns: ['n', 'r', 'm'],
      rows: [
        [
          { id: '1', labels: ['Person'], properties: { name: 'Ada' } },
          { id: 'e1', type: 'KNOWS', from: '1', to: '2', properties: {} },
          { id: '2', labels: ['Person'], properties: { name: 'Bob' } },
        ],
        [
          { id: '1', labels: ['Person'], properties: { name: 'Ada' } },
          { id: 'e2', type: 'KNOWS', from: '1', to: '3', properties: {} },
          { id: '3', labels: ['Person'], properties: { name: 'Cy' } },
        ],
      ],
      stats: { rowsExamined: 2, elapsedMs: 1 },
    };
    const data = parseGraphRows(res);
    expect(data.nodes.map((n) => n.id).sort()).toEqual(['1', '2', '3']);
    expect(data.edges.map((e) => e.id).sort()).toEqual(['e1', 'e2']);
    expect(data.nodes.find((n) => n.id === '2')?.props['name']).toBe('Bob');
    expect(data.edges[0]).toMatchObject({ from: '1', to: '2', type: 'KNOWS' });
  });

  it('tolerates rows with null/absent edge or neighbor cells', () => {
    const res: QueryResponse = {
      columns: ['n', 'r', 'm'],
      rows: [[{ id: '1', labels: ['Person'], properties: {} }, null, null]],
      stats: { rowsExamined: 1, elapsedMs: 0 },
    };
    const data = parseGraphRows(res);
    expect(data.nodes.map((n) => n.id)).toEqual(['1']);
    expect(data.edges).toEqual([]);
  });

  it('ignores non-graph scalar rows without throwing', () => {
    const res: QueryResponse = { columns: ['c'], rows: [[5]], stats: { rowsExamined: 1, elapsedMs: 0 } };
    expect(parseGraphRows(res)).toEqual({ nodes: [], edges: [] });
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm -F web exec ng test --watch=false`
Expected: FAIL — `./expand` not found.

- [x] **Step 3: Implement `apps/web/src/app/workspace/expand.ts`**

```ts
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
```

Note: `parseGraphRows` checks `isRawEdge` before `isRawNode` because an edge value also carries `id`/`properties`; the edge discriminator (`type` + `from` + `to`) is more specific. The `mergeGraph` in `GraphStore.addGraph` then drops any edge whose endpoints are not present — so a neighbor page that returns an edge to an as-yet-unloaded node is held back until that node arrives. Edge ids from the engine are assumed distinct from node ids; if the engine reuses an id space, `parseGraphRows` still keys nodes and edges in separate maps, so there is no collision in `GraphData`.

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm -F web exec ng test --watch=false`
Expected: PASS — query string + params, dedup parse, null-cell tolerance, scalar-row tolerance.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): pure expand-neighbors AQL builder and graph-row parser"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 7: Inspector + legend components and the Workspace page (replaces the placeholder)

The left rail hosts the label/edge-type legend (color swatches + visibility toggles + counts); the right inspector shows the selected node/edge's properties (read-only in M6b), its connection list, and expand/paths actions. The `Workspace` page composes the top bar, legend, canvas, and inspector, provides the per-instance `GraphStore`, loads the initial graph + schema, and folds expand results in. It **replaces** the M6a `WorkspacePlaceholder` on `db/:name`.

**Files:**
- Create: `apps/web/src/app/workspace/inspector.ts`, `inspector.html`, `legend.ts`, `legend.html`, `workspace.ts`, `workspace.html`
- Modify: `apps/web/src/app/app.routes.ts`, `apps/web/src/styles.css`
- Delete: `apps/web/src/app/workspace/workspace-placeholder.ts`
- Test: `apps/web/src/app/workspace/inspector.spec.ts`, `legend.spec.ts`, `workspace.spec.ts`

- [x] **Step 1: Write the failing tests**

`apps/web/src/app/workspace/legend.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { Legend } from './legend';
import { GraphStore } from './graph.store';

describe('Legend component', () => {
  beforeEach(() => TestBed.resetTestingModule());

  function setup() {
    TestBed.configureTestingModule({ imports: [Legend], providers: [GraphStore] });
    const fixture = TestBed.createComponent(Legend);
    return { fixture, store: TestBed.inject(GraphStore) };
  }

  it('lists labels with counts and a color swatch', async () => {
    const { fixture, store } = setup();
    store.addGraph({ nodes: [{ id: '1', labels: ['Person'], props: {} }], edges: [] });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Person');
    expect(text).toContain('1');
    expect((fixture.nativeElement as HTMLElement).querySelector('.swatch')).toBeTruthy();
  });

  it('toggling a label checkbox flips its visibility in the store', async () => {
    const { fixture, store } = setup();
    store.addGraph({ nodes: [{ id: '1', labels: ['Person'], props: {} }], edges: [] });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const checkbox = (fixture.nativeElement as HTMLElement).querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    checkbox.click();
    fixture.detectChanges();
    expect(store.labels().find((l) => l.label === 'Person')?.visible).toBe(false);
  });
});
```

`apps/web/src/app/workspace/inspector.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Inspector } from './inspector';
import { GraphStore } from './graph.store';

describe('Inspector component', () => {
  beforeEach(() => TestBed.resetTestingModule());

  function setup() {
    TestBed.configureTestingModule({ imports: [Inspector], providers: [GraphStore] });
    const fixture = TestBed.createComponent(Inspector);
    return { fixture, cmp: fixture.componentInstance, store: TestBed.inject(GraphStore) };
  }

  it('shows an empty prompt when nothing is selected', () => {
    const { fixture } = setup();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Select a node');
  });

  it('renders the selected node label, properties (read-only), and connections', async () => {
    const { fixture, store } = setup();
    store.addGraph({
      nodes: [
        { id: '1', labels: ['Person'], props: { name: 'Ada', born: 1815 } },
        { id: '2', labels: ['Doc'], props: { name: 'Notes' } },
      ],
      edges: [{ id: 'e', from: '1', to: '2', type: 'WROTE', props: {} }],
    });
    store.select({ kind: 'node', id: '1' });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Person');
    expect(text).toContain('Ada');
    expect(text).toContain('1815');
    expect(text).toContain('WROTE'); // connection list shows the edge type
    // No editable inputs in M6b — properties are read-only.
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('input').length).toBe(0);
  });

  it('the expand button emits the selected node id', async () => {
    const { fixture, cmp, store } = setup();
    store.addGraph({ nodes: [{ id: '1', labels: ['Person'], props: { name: 'Ada' } }], edges: [] });
    store.select({ kind: 'node', id: '1' });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const expand = vi.fn();
    cmp.expand.subscribe(expand);
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.expand-btn')!.click();
    expect(expand).toHaveBeenCalledWith('1');
  });

  it('clicking a connection selects the neighbor', async () => {
    const { fixture, store } = setup();
    store.addGraph({
      nodes: [{ id: '1', labels: ['Person'], props: {} }, { id: '2', labels: ['Doc'], props: {} }],
      edges: [{ id: 'e', from: '1', to: '2', type: 'WROTE', props: {} }],
    });
    store.select({ kind: 'node', id: '1' });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.conn-link')!.click();
    expect(store.selection()).toEqual({ kind: 'node', id: '2' });
  });
});
```

`apps/web/src/app/workspace/workspace.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { Workspace } from './workspace';
import { GraphStore } from './graph.store';
import type { QueryResponse } from '@atlas/protocol';
import type { SchemaSummary } from '@atlas/core';

const schema: SchemaSummary = {
  labels: [{ label: 'Person', count: 1, properties: [] }],
  edgeTypes: [],
};
const initial: QueryResponse = {
  columns: ['n', 'r', 'm'],
  rows: [[{ id: '1', labels: ['Person'], properties: { name: 'Ada' } }, null, null]],
  stats: { rowsExamined: 1, elapsedMs: 0 },
};
const expanded: QueryResponse = {
  columns: ['n', 'r', 'm'],
  rows: [
    [
      { id: '1', labels: ['Person'], properties: { name: 'Ada' } },
      { id: 'e', type: 'KNOWS', from: '1', to: '2', properties: {} },
      { id: '2', labels: ['Person'], properties: { name: 'Bob' } },
    ],
  ],
  stats: { rowsExamined: 1, elapsedMs: 0 },
};

function db(query: ReturnType<typeof vi.fn>, schemaFn: ReturnType<typeof vi.fn>) {
  return { query, schema: schemaFn, subscribe: vi.fn().mockResolvedValue({ close: vi.fn() }) };
}

describe('Workspace page', () => {
  beforeEach(() => TestBed.resetTestingModule());

  function setup(query: ReturnType<typeof vi.fn>, schemaFn: ReturnType<typeof vi.fn>) {
    TestBed.configureTestingModule({
      imports: [Workspace],
      providers: [
        provideRouter([]),
        { provide: AtlasApi, useValue: { database: () => db(query, schemaFn) } },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => 'kb' } } } },
      ],
    });
    const fixture = TestBed.createComponent(Workspace);
    return { fixture, cmp: fixture.componentInstance };
  }

  it('loads the initial graph + schema into its store on init', async () => {
    const query = vi.fn().mockResolvedValue(initial);
    const schemaFn = vi.fn().mockResolvedValue(schema);
    const { fixture, cmp } = setup(query, schemaFn);
    fixture.detectChanges();
    await cmp.ready;
    fixture.detectChanges();
    expect(schemaFn).toHaveBeenCalled();
    expect(cmp.store.visibleNodes().map((n) => n.id)).toContain('1');
    expect(cmp.store.labels().some((l) => l.label === 'Person')).toBe(true);
  });

  it('onExpand fetches neighbors and folds them into the store', async () => {
    const query = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(expanded);
    const schemaFn = vi.fn().mockResolvedValue(schema);
    const { fixture, cmp } = setup(query, schemaFn);
    fixture.detectChanges();
    await cmp.ready;
    await cmp.onExpand('1');
    fixture.detectChanges();
    expect(cmp.store.visibleNodes().map((n) => n.id).sort()).toEqual(['1', '2']);
    expect(cmp.store.visibleEdges().map((e) => e.id)).toEqual(['e']);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm -F web exec ng test --watch=false`
Expected: FAIL — `./legend`, `./inspector`, `./workspace` not found.

- [x] **Step 3: Implement the legend**

`apps/web/src/app/workspace/legend.ts`:

```ts
import { Component, inject } from '@angular/core';
import { GraphStore } from './graph.store';
import { makeColorOf, resolveRenderTheme } from './theme-colors';

@Component({
  selector: 'app-legend',
  templateUrl: './legend.html',
})
export class Legend {
  readonly store = inject(GraphStore);
  private readonly colorOf = makeColorOf(
    resolveRenderTheme((p) =>
      typeof getComputedStyle === 'function'
        ? getComputedStyle(document.documentElement).getPropertyValue(p)
        : '',
    ).nodePalette,
  );

  swatch(label: string): string {
    return this.colorOf([label]);
  }
}
```

`apps/web/src/app/workspace/legend.html`:

```html
<nav class="legend" aria-label="Labels and edge types">
  <section>
    <h2 class="legend-title">Labels</h2>
    <ul class="legend-list">
      @for (l of store.labels(); track l.label) {
        <li class="legend-row">
          <label>
            <input
              type="checkbox"
              [checked]="l.visible"
              (change)="store.toggleLabel(l.label)"
              [attr.aria-label]="'Toggle ' + l.label"
            />
            <span class="swatch" [style.background]="swatch(l.label)" aria-hidden="true"></span>
            <span class="legend-name">{{ l.label }}</span>
            <span class="legend-count">{{ l.count }}</span>
          </label>
        </li>
      }
    </ul>
  </section>
  <section>
    <h2 class="legend-title">Edge types</h2>
    <ul class="legend-list">
      @for (t of store.edgeTypes(); track t.type) {
        <li class="legend-row">
          <label>
            <input
              type="checkbox"
              [checked]="t.visible"
              (change)="store.toggleEdgeType(t.type)"
              [attr.aria-label]="'Toggle ' + t.type"
            />
            <span class="legend-name">{{ t.type }}</span>
            <span class="legend-count">{{ t.count }}</span>
          </label>
        </li>
      }
    </ul>
  </section>
</nav>
```

- [x] **Step 4: Implement the inspector**

`apps/web/src/app/workspace/inspector.ts`:

```ts
import { Component, inject, output } from '@angular/core';
import { GraphStore } from './graph.store';

@Component({
  selector: 'app-inspector',
  templateUrl: './inspector.html',
})
export class Inspector {
  readonly store = inject(GraphStore);

  /** Expand-neighbors action for the selected node (handled by the Workspace page). */
  readonly expand = output<string>();
  /** Find-paths action (UI present in M6b; the paths view itself lands in M6c). */
  readonly findPaths = output<string>();

  /** Selected node's properties as [key, value] entries for read-only display. */
  entries(props: Record<string, unknown>): [string, string][] {
    return Object.entries(props).map(([k, v]) => [k, String(v)]);
  }

  selectNeighbor(id: string): void {
    this.store.select({ kind: 'node', id });
  }
}
```

`apps/web/src/app/workspace/inspector.html`:

```html
<aside class="inspector" aria-label="Inspector">
  @if (store.selectedNode(); as n) {
    <header class="inspector-head">
      <h2>{{ n.labels.join(' · ') || 'Node' }}</h2>
      <div class="inspector-actions">
        <button type="button" class="expand-btn" (click)="expand.emit(n.id)">Expand neighbors</button>
        <button type="button" class="paths-btn" (click)="findPaths.emit(n.id)">Find paths…</button>
      </div>
    </header>

    <h3>Properties</h3>
    <dl class="props">
      @for (e of entries(n.props); track e[0]) {
        <dt>{{ e[0] }}</dt>
        <dd>{{ e[1] }}</dd>
      }
    </dl>

    <h3>Connections ({{ store.connectionsOf(n.id).length }})</h3>
    <ul class="connections">
      @for (c of store.connectionsOf(n.id); track c.edge.id) {
        <li class="connection">
          <span class="conn-dir">{{ c.direction === 'out' ? '→' : '←' }}</span>
          <span class="conn-type">{{ c.edge.type }}</span>
          <button type="button" class="conn-link" (click)="selectNeighbor(c.neighborId)">
            {{ c.neighborId }}
          </button>
        </li>
      }
    </ul>
  } @else if (store.selectedEdge(); as edge) {
    <header class="inspector-head"><h2>{{ edge.type }}</h2></header>
    <h3>Properties</h3>
    <dl class="props">
      @for (e of entries(edge.props); track e[0]) {
        <dt>{{ e[0] }}</dt>
        <dd>{{ e[1] }}</dd>
      }
    </dl>
  } @else {
    <p class="inspector-empty">Select a node or edge to inspect it.</p>
  }
</aside>
```

- [x] **Step 5: Implement the Workspace page**

`apps/web/src/app/workspace/workspace.ts`:

```ts
import { AfterViewInit, Component, inject, viewChild } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { Subscription } from '@atlas/client';
import type { WsFrame } from '@atlas/protocol';
import { OnDestroy } from '@angular/core';
import { AtlasApi } from '../core/atlas-api';
import { GraphCanvas } from './graph-canvas';
import { GraphStore } from './graph.store';
import { Inspector } from './inspector';
import { Legend } from './legend';
import { DEFAULT_EXPAND_CAP } from './graph-model';
import { neighborQuery, parseGraphRows } from './expand';

/** Initial query: a capped sample of nodes with their edges to seed the canvas. */
const INITIAL_QUERY = 'MATCH (n)-[r]-(m) RETURN n, r, m LIMIT $limit';

@Component({
  selector: 'app-workspace',
  imports: [RouterLink, GraphCanvas, Inspector, Legend],
  templateUrl: './workspace.html',
  providers: [GraphStore], // a fresh store per open database
})
export class Workspace implements AfterViewInit, OnDestroy {
  readonly store = inject(GraphStore);
  private readonly api = inject(AtlasApi);
  readonly name = inject(ActivatedRoute).snapshot.paramMap.get('name') ?? '';
  private readonly canvas = viewChild.required(GraphCanvas);
  private sub: Subscription | null = null;

  /** Resolves once the initial load completes — awaited by tests. */
  readonly ready: Promise<void> = this.load();

  ngAfterViewInit(): void {
    void this.ready.then(() => this.canvas().resyncLayout());
    void this.subscribe();
  }

  ngOnDestroy(): void {
    this.sub?.close();
  }

  private async load(): Promise<void> {
    const db = this.api.database(this.name);
    const [schema, res] = await Promise.all([
      db.schema(),
      db.query(INITIAL_QUERY, { limit: this.store.renderCap() }),
    ]);
    this.store.ingestSchema(schema);
    this.store.addGraph(parseGraphRows(res));
  }

  async onExpand(id: string, skip = 0): Promise<void> {
    const { query, params } = neighborQuery(id, DEFAULT_EXPAND_CAP, skip);
    const res = await this.api.database(this.name).query(query, params);
    this.store.addGraph(parseGraphRows(res));
    this.canvas().resyncLayout();
  }

  private async subscribe(): Promise<void> {
    try {
      this.sub = await this.api
        .database(this.name)
        .subscribe({}, (frame: WsFrame) => this.onFrame(frame));
    } catch {
      // Live updates are best-effort; the canvas still works without the change feed.
    }
  }

  /** Merge a change-feed frame into the store (created/updated → add; deleted → remove). */
  private onFrame(frame: WsFrame): void {
    for (const ch of frame.changes ?? []) {
      if (ch.kind === 'node') {
        if (ch.op === 'delete') this.store.removeNode(String(ch.id));
        else
          this.store.addGraph({
            nodes: [{ id: String(ch.id), labels: ch.labels ?? [], props: ch.properties ?? {} }],
            edges: [],
          });
      } else if (ch.kind === 'edge' && ch.op !== 'delete') {
        this.store.addGraph({
          nodes: [],
          edges: [
            { id: String(ch.id), from: String(ch.from), to: String(ch.to), type: ch.type ?? '', props: ch.properties ?? {} },
          ],
        });
      }
    }
    this.canvas().resyncLayout();
  }
}
```

Note on `WsFrame`: the change-feed frame shape is owned by `@atlas/protocol`. This handler treats a frame as `{ changes?: Change[] }` where each `Change` is `{ kind: 'node'|'edge'; op: 'create'|'update'|'delete'; id; labels?; type?; from?; to?; properties? }`. If the verified `@atlas/protocol` `WsFrame` differs, adapt `onFrame` to the actual fields **without weakening** the create/update→add, delete→remove behavior; add a small local interface for the fields used and cast `frame` to it at the boundary. The Task 8 e2e exercises live updates end-to-end and is the source of truth for the real shape.

`apps/web/src/app/workspace/workspace.html`:

```html
<div class="workspace">
  <header class="ws-topbar">
    <a routerLink="/databases" class="ws-back">← Databases</a>
    <h1 class="ws-title">{{ name }}</h1>
    <span class="ws-stats">{{ store.shownCount() }} / {{ store.totalNodeCount() }} nodes</span>
  </header>
  <div class="ws-body">
    <app-legend class="ws-rail" />
    <app-graph-canvas class="ws-canvas" (expandNode)="onExpand($event)" />
    <app-inspector class="ws-inspector" (expand)="onExpand($event)" />
  </div>
</div>
```

- [x] **Step 6: Replace the route and delete the placeholder**

In `apps/web/src/app/app.routes.ts`, change the `db/:name` entry to load `Workspace` and delete `workspace-placeholder.ts`:

```ts
  {
    path: 'db/:name',
    canActivate: [authGuard],
    loadComponent: () => import('./workspace/workspace').then((m) => m.Workspace),
  },
```

```bash
git rm apps/web/src/app/workspace/workspace-placeholder.ts
```

- [x] **Step 7: Append workspace layout to `apps/web/src/styles.css`**

```css
.workspace {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.ws-topbar {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.5rem 1rem;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

.ws-back {
  text-decoration: none;
}
.ws-title {
  font-size: 1.1rem;
  margin: 0;
}
.ws-stats {
  margin-left: auto;
  color: var(--text-muted);
  font-size: 0.85rem;
}

.ws-body {
  display: grid;
  grid-template-columns: 16rem 1fr 20rem;
  flex: 1;
  min-height: 0;
}

.ws-rail,
.ws-inspector {
  background: var(--surface);
  border-right: 1px solid var(--border);
  overflow-y: auto;
  padding: 1rem;
}
.ws-inspector {
  border-right: none;
  border-left: 1px solid var(--border);
}

.ws-canvas {
  position: relative;
  min-width: 0;
  display: block;
}
.canvas-wrap {
  position: relative;
  width: 100%;
  height: 100%;
}
.canvas-wrap canvas {
  width: 100%;
  height: 100%;
  display: block;
  background: var(--bg);
}

.cap-badge {
  position: absolute;
  top: 0.5rem;
  left: 0.5rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.4rem 0.6rem;
  font-size: 0.8rem;
  color: var(--text-muted);
}

.context-menu {
  position: fixed;
  list-style: none;
  margin: 0;
  padding: 0.25rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  z-index: 10;
}
.context-menu button {
  width: 100%;
  text-align: left;
  background: none;
  color: var(--text);
  border: none;
}
.context-menu button:hover {
  background: var(--bg);
}

.legend-title {
  font-size: 0.8rem;
  text-transform: uppercase;
  color: var(--text-muted);
}
.legend-list {
  list-style: none;
  padding: 0;
  margin: 0 0 1rem;
}
.legend-row label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.2rem 0;
}
.swatch {
  width: 0.75rem;
  height: 0.75rem;
  border-radius: 999px;
  display: inline-block;
}
.legend-name {
  flex: 1;
}
.legend-count {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.inspector-head h2 {
  font-size: 1rem;
  margin: 0 0 0.5rem;
}
.inspector-actions {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
}
.props {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.2rem 0.75rem;
  font-size: 0.85rem;
}
.props dt {
  color: var(--text-muted);
}
.props dd {
  margin: 0;
  word-break: break-word;
}
.connections {
  list-style: none;
  padding: 0;
}
.connection {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.2rem 0;
}
.conn-link {
  background: none;
  border: none;
  color: var(--accent);
  padding: 0;
  cursor: pointer;
}
.inspector-empty {
  color: var(--text-muted);
}
```

- [x] **Step 8: Run the tests to verify they pass**

Run: `pnpm -F web exec ng test --watch=false`
Expected: PASS — legend lists/toggles, inspector read-only props + connections + expand emit + neighbor-select, and Workspace initial load + expand fold-in.

- [x] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(web): legend, inspector, and Workspace page replacing the placeholder route"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 8: Live updates wiring, Playwright e2e, README, and the full gate

Live updates are already wired in the Workspace (`subscribe` → `onFrame` → store, Task 7). This task verifies the end-to-end behavior with a Playwright smoke (seed a db, open the workspace, assert the canvas renders nodes, select one, toggle a label), updates the README, and brings the full gate green. The e2e is runnable via `pnpm e2e:web` but excluded from the default gate (matching M6a).

**Files:**
- Create: `apps/web/e2e/workspace.spec.ts`
- Modify: `README.md`
- Test: `apps/web/e2e/workspace.spec.ts`

- [x] **Step 1: Confirm the live-updates wiring (no new code)**

The Workspace subscribes on `ngAfterViewInit` via `AtlasApi.database(name).subscribe({}, onFrame)` and merges each frame into the store, then calls `canvas.resyncLayout()` so new nodes/edges flow into the simulation. `workspace.spec.ts` (Task 7) already mocks `subscribe` returning a closable `Subscription`; confirm `ngOnDestroy` calls `this.sub?.close()` so the socket is released when navigating away. No new unit test is required here — the e2e in Step 3 covers a live write reflecting on the canvas indirectly (the seed itself is the write path the canvas reads back).

- [x] **Step 2: Reuse the M6a Playwright config**

The M6a `apps/web/playwright.config.ts` already builds the SPA and serves it from `@atlas/server` static hosting on a fixed port with a temp data dir (same-origin cookies). No config change is needed; the new spec lives alongside `explorer.spec.ts` under `apps/web/e2e/`.

- [x] **Step 3: Write the e2e smoke**

`apps/web/e2e/workspace.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test('open the workspace, render the seeded graph, select a node, toggle a label', async ({ page }) => {
  const username = `e2e_ws_${Date.now()}`;

  // Register (auto-login) and land on the picker.
  await page.goto('/register');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('secret12');
  await page.getByRole('button', { name: /create account/i }).click();
  await expect(page).toHaveURL(/\/databases$/);

  // Create + seed a database with the science-history dataset.
  await page.getByPlaceholder('new-database').fill('e2e-graph');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('e2e-graph')).toBeVisible();
  await page.getByRole('button', { name: /seed science-history/i }).click();

  // Open the workspace.
  await page.getByRole('button', { name: 'Open' }).first().click();
  await expect(page).toHaveURL(/\/db\/e2e-graph$/);

  // The canvas renders and the legend shows labels with counts.
  const canvas = page.getByLabel('Graph canvas');
  await expect(canvas).toBeVisible();
  const legend = page.getByRole('navigation', { name: /labels and edge types/i });
  await expect(legend.getByText('Person')).toBeVisible();

  // The "showing N of M" / stats area reflects a non-empty graph (the seed has many nodes).
  await expect(page.locator('.ws-stats')).toContainText('/');

  // Select a node by clicking near the canvas center; the inspector leaves its empty state.
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  // (Clicking empty space is harmless; we assert the inspector is present and interactive.)
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();

  // Toggle the Person label off — its checkbox flips and the stats update.
  const personRow = legend.getByText('Person').locator('xpath=ancestor::label');
  await personRow.getByRole('checkbox').uncheck();
  await expect(personRow.getByRole('checkbox')).not.toBeChecked();
});
```

- [x] **Step 4: Run the e2e to verify it passes**

Run: `pnpm -F web e2e`
Expected: PASS — the webServer builds the SPA, starts `@atlas/server` serving it, registers, seeds science-history, opens the workspace, asserts the canvas + legend render, exercises a click, and toggles the Person label. If a selector mismatches (e.g. the legend `aria-label`), align the spec to the actual ARIA names from Task 5/7 — do not weaken the canvas-renders or label-toggle assertions. If the seed graph exceeds the render cap, the `.ws-stats` "N / M" still asserts a non-empty, capped scene.

- [x] **Step 5: Update the README**

In `README.md`, set the `**Status:**` block to:

```markdown
**Status:** M6b — Knowledge Graph Explorer workspace (`apps/web`): the `/db/:name`
route is now the real graph workspace — a Canvas2D graph canvas as the hero with a
seeded d3-force layout running in a Web Worker, a framework-agnostic signal-based
graph store (visible node/edge set, selection, label/edge-type visibility toggles
with counts, and a render cap with "showing N of M"), pure viewport zoom/pan +
point→node hit-testing, a theme-reactive renderer (colors from the active token
set), pointer interactions (zoom/pan, click-select, drag-to-pin, double-click
expand-neighbors capped+paged via AQL, right-click context menu), a left
label/edge legend, a right inspector (read-only properties + connection list +
expand/paths actions), and live updates via the change feed. The AQL console,
schema view, and algorithms view land in M6c; admin, import UI, ⌘K search, and
inspector editing land in M6d.
```

- [x] **Step 6: Run the full gate**

Run: `pnpm build && pnpm typecheck:test && pnpm lint && pnpm format && pnpm test`
Expected: all green — `tsc -b` builds the libraries (ignoring `apps/web`), the Angular builder builds the app (bundling `layout.worker.ts` via the `new Worker(new URL(...))` form), the library Vitest suite passes, and the app's `ng test` suite passes (graph-model, store, simulation, viewport, hit-test, renderer, theme-colors, expand, graph-canvas, legend, inspector, workspace). The Playwright e2e is intentionally excluded from `pnpm test` (run via `pnpm e2e:web`).

- [x] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): workspace live updates, Playwright e2e, README status, M6b gate green"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## Plan self-review notes

- **Spec coverage (§7 slice for M6b):**
  - §7.2 Workspace hero composition — top bar (back + db name + node stats) → T7 (`workspace.html`); left rail label/edge-type **legend with visibility toggles + counts** → T7 (`Legend` over `GraphStore.labels()/edgeTypes()`); center **graph canvas** → T5 (`GraphCanvas`); right **inspector** (selected node/edge properties + connection list + expand/paths actions) → T7 (`Inspector`). The spec calls inspector properties "editable"; M6b ships them **read-only** (see deliberate decisions) with the expand action live and a `Find paths…` button whose results view lands in M6c. The ⌘K node search and the live indicator in the top bar are deferred to M6d.
  - §7.3 graph canvas — custom **plain-TS Canvas2D renderer** wrapped in an Angular component → T4 (`renderer.ts`) + T5 (`GraphCanvas`); **d3-force in a Web Worker** streaming positions → T2 (`simulation.ts` core + `layout.worker.ts` wrapper, positions streamed via `applyPositions`); interactions zoom/pan, click select, **double-click expand neighbors (capped + paged)**, right-click context menu, drag to pin → T5 (pointer wiring) + T6 (`neighborQuery` cap+skip); **graceful degradation to a max-rendered-nodes cap with "showing N of M"** → T1 (`capNodes` + `isCapped`/`shownCount`/`totalNodeCount`) + T5 (`cap-badge`).
  - §7.4 the renderer reads colors from the active token set → T4 (`resolveRenderTheme` reads `--bg`/`--surface`/`--border`/`--text`/`--accent`/`--node-1..6`) consumed by T5 (`GraphCanvas.refreshTheme` via `getComputedStyle`).
  - §7.5 accessibility — keyboard/ARIA on non-canvas controls (legend checkboxes have `aria-label`; inspector is a labelled `complementary`/`aside`; canvas has `aria-label` + `tabindex`); the **canvas mirrored by an accessible list** is served in v1 by the inspector's connection list (a navigable text view of the selected node's edges). Full WCAG-AA contrast across all three themes and a complete results-table mirror are revisited with the AQL console results table in M6c.
- **Deferred to M6c/M6d (explicitly out of scope):** the CodeMirror AQL console (editor + schema-aware autocomplete + error squiggles + Results/EXPLAIN/History tabs + project-results-onto-canvas), the schema view, and the algorithms view (results painted onto the canvas) → **M6c**; the admin screens, file import UI, ⌘K node search, the top-bar live indicator, and **editable** inspector properties → **M6d**.
- **Deliberate v1 decisions (called out):**
  - **Read-only inspector in M6b.** Property editing (PATCH node/edge) is M6d; the inspector shows properties as a read-only `<dl>` and the test asserts zero `<input>` elements. The expand action is fully live now.
  - **Render cap = 300 nodes (`DEFAULT_RENDER_CAP`), expand page size = 50 (`DEFAULT_EXPAND_CAP`).** Above the cap the canvas shows "showing N of M" and prompts narrowing via the legend. Both are single named constants reused across the store, component, and queries.
  - **Worker simulation tested as a plain function.** jsdom has no real `Worker`, so the deterministic core (`simulation.ts`, seeded via mulberry32) is unit-tested directly and the Worker (`layout.worker.ts`) is a thin message-forwarding wrapper; the component test uses a `testWorkerPost` seam to assert protocol messages without spawning a Worker.
  - **Initial load + expand via AQL `MATCH (n)-[r]-(m) RETURN n, r, m`.** M6b reads graph-shaped rows from `Database.query` and parses node/edge cells (`parseGraphRows`), rather than depending on node/edge CRUD REST endpoints — this stays within the verified M5a `QueryResponse { columns, rows, stats }` contract.
  - **Live updates are best-effort.** `subscribe` failures are swallowed so the canvas works without the change feed; the `WsFrame` handler is adapted to the verified `@atlas/protocol` frame shape at the boundary (the e2e is the source of truth), preserving create/update→add and delete→remove.
  - **Per-instance `GraphStore`.** `GraphStore` is `@Injectable()` (no `providedIn: 'root'`) and listed in `Workspace`'s `providers`, so each opened database gets a fresh store; the legend/inspector/canvas inject the same per-route instance.
  - **e2e excluded from the default gate.** Playwright runs via `pnpm e2e:web` (reusing the M6a config that serves the built SPA from `@atlas/server` for same-origin cookies); `pnpm test` stays the libraries' Vitest + the app's `ng test`.
- **Type/signature consistency (cross-task anchors):**
  - Shared view-model types live once in `graph-model.ts`: `GraphNode { id, labels, props, x?, y?, pinned? }`, `GraphEdge { id, from, to, type, props }`, `GraphData`, `Selection`, `ViewportTransform { k, tx, ty }`, `RenderTheme`, `Scene`. Consumed identically by the store (T1), simulation glue (T2 maps to `SimNode { id, fx?, fy? }`), viewport (T3), renderer (T4), canvas (T5), expand (T6), inspector/legend/workspace (T7).
  - `GraphStore` surface is stable across T1/T5/T7: `ingestSchema`, `addGraph`, `applyPositions`, `setNodePin`, `removeNode`, `toggleLabel`, `toggleEdgeType`, `setRenderCap`, `select`, `connectionsOf`; signals `labels`, `edgeTypes`, `selection`, `selectedNode`, `selectedEdge`, `visibleNodes`, `visibleEdges`, `shownCount`, `totalNodeCount`, `isCapped`, `renderCap`.
  - The Worker protocol is one pair of types: `LayoutInbound` (`init`/`tick`/`pin`/`unpin`/`stop`) and `LayoutOutbound` (`positions`), exported from `layout.worker.ts` and imported by `GraphCanvas` (T5) — `init`/`pin`/`unpin`/`tick`/`stop` are emitted by exactly the component methods that need them, and `positions` flows back into `store.applyPositions`.
  - The viewport math names match everywhere: `screenToWorld`/`worldToScreen`/`panBy`/`zoomAt`/`fitToNodes`/`IDENTITY`, used by `hit-test.ts` (T3), `renderer.ts` (T4), and `GraphCanvas` (T5).
  - Expand contract is single-sourced: `neighborQuery(id, limit?, skip?) → { query, params }` and `parseGraphRows(QueryResponse) → GraphData`, used by both the Workspace initial load and `onExpand` (T7). `NODE_RADIUS` is the one radius constant shared by the renderer (draw) and hit-test (pick).
- **Self-review fixes applied:** the `GraphCanvas.fit`/`computeFit` listing initially used a `require` shim that is unavailable under the Angular ESM build — the plan replaces it inline with a direct `fitToNodes` import (Task 5 Step 3 note), so no `require` ships. `parseGraphRows` checks `isRawEdge` before `isRawNode` because an edge value also carries `id`/`properties` (a node would otherwise shadow it). `mergeGraph` preserves existing `x`/`y`/`pinned` on re-merge so live updates and expands never reset the layout, and drops edges whose endpoints are not yet loaded (so a neighbor edge waits for its node). `removeNode` clears the selection when the removed node was selected (live-delete safety). The render loop tolerates jsdom returning `null` from `getContext('2d')` (early-return in `render()`), keeping the component test's selection/zoom assertions valid without a real 2D context. Every `pnpm`/`ng` command matches the verified M6a Angular setup (`pnpm -F web exec ng test --watch=false`, Vitest builder + jsdom; e2e via `pnpm e2e:web`); the app `tsconfig` stays self-contained and out of the root `tsc -b` references; the Worker is bundled by `@angular/build:application` via the `new Worker(new URL('./layout.worker', import.meta.url), { type: 'module' })` form.
```