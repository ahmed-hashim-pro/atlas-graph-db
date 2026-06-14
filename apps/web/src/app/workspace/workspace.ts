import { AfterViewInit, Component, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { Subscription } from '@atlas/client';
import type { WsFrame } from '@atlas/protocol';
import type { Op } from '@atlas/core';
import { OnDestroy } from '@angular/core';
import { AtlasApi } from '../core/atlas-api';
import { AlgorithmsView } from './algorithms-view';
import { Console } from './console';
import { ConsoleStore } from './console.store';
import { GraphCanvas } from './graph-canvas';
import { GraphStore } from './graph.store';
import { GraphStoreWorkspaceAdapter } from './graph-store.adapter';
import { Inspector } from './inspector';
import { Legend } from './legend';
import { SchemaView } from './schema-view';
import { DEFAULT_EXPAND_CAP } from './graph-model';
import { neighborQuery, parseGraphRows } from './expand';
import { WORKSPACE_GRAPH_STORE } from './workspace-graph-store.contract';
import { CommandPalette } from '../search/command-palette';
import type { NodeHit } from '../search/node-search';

/** Which dock panel is open below the canvas. */
export type WorkspaceDock = 'console' | 'schema' | 'algorithms' | null;

/** Initial query: a capped sample of nodes with their edges to seed the canvas. */
const INITIAL_QUERY = 'MATCH (n)-[r]-(m) RETURN n, r, m LIMIT $limit';

@Component({
  selector: 'app-workspace',
  imports: [
    RouterLink,
    GraphCanvas,
    Inspector,
    Legend,
    Console,
    SchemaView,
    AlgorithmsView,
    CommandPalette,
  ],
  templateUrl: './workspace.html',
  providers: [
    GraphStore, // a fresh store per open database
    // The console's "project to canvas" and the algorithms view's
    // "paint onto canvas" target this workspace's canvas store (not the
    // app-wide in-memory default), so both reach the live renderer.
    { provide: WORKSPACE_GRAPH_STORE, useClass: GraphStoreWorkspaceAdapter },
    // Scope the console store here too: as a root singleton its
    // WORKSPACE_GRAPH_STORE would resolve to the dead in-memory default, so
    // "project to canvas" never reached the real GraphStore. The algorithms
    // view injects WORKSPACE_GRAPH_STORE directly (component element injector),
    // so it already resolves the adapter below.
    ConsoleStore,
  ],
})
export class Workspace implements AfterViewInit, OnDestroy {
  readonly store = inject(GraphStore);
  private readonly api = inject(AtlasApi);
  readonly name = inject(ActivatedRoute).snapshot.paramMap.get('name') ?? '';
  private readonly canvas = viewChild.required(GraphCanvas);
  private sub: Subscription | null = null;

  /** The dock panel open below the canvas; the console opens by default. */
  readonly dock = signal<WorkspaceDock>('console');

  toggleDock(panel: WorkspaceDock): void {
    this.dock.update((d) => (d === panel ? null : panel));
  }

  /** Whether the ⌘K command palette overlay is open. */
  readonly paletteOpen = signal(false);
  private readonly palette = viewChild(CommandPalette);

  /** ⌘/Ctrl+K toggles the palette; bound on the workspace host in the template. */
  onHostKey(ev: KeyboardEvent): void {
    if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'k' || ev.key === 'K')) {
      ev.preventDefault();
      this.paletteOpen.update((v) => !v);
      if (this.paletteOpen())
        queueMicrotask(() => {
          this.palette()?.captureOpener();
          this.palette()?.focusInput();
        });
    }
  }

  /** Open the palette from the topbar button and focus its input once mounted. */
  openPalette(): void {
    this.paletteOpen.set(true);
    queueMicrotask(() => {
      this.palette()?.captureOpener();
      this.palette()?.focusInput();
    });
  }

  closePalette(): void {
    this.paletteOpen.set(false);
  }

  /**
   * Bring a searched node onto the canvas: fetch it (with its immediate neighbors,
   * reusing the expand query so the node is not stranded), merge into the store,
   * select it, close the palette, and re-fit the camera so the node is centered.
   */
  async onPick(hit: NodeHit): Promise<void> {
    this.paletteOpen.set(false);
    const { query, params } = neighborQuery(hit.id);
    try {
      const res = await this.api.database(this.name).query(query, params);
      this.store.addGraph(parseGraphRows(res));
    } catch {
      // If the node has no neighbors (or the expand query fails), still select it
      // from whatever is already loaded so the inspector opens.
    }
    this.store.select({ kind: 'node', id: hit.id });
    this.canvas().fit();
  }

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

  /**
   * Merge a change-feed frame into the store. The real `@atlas/protocol` `WsFrame`
   * delivers committed transactions as `{ type: 'batch'; ops: Op[] }` where each
   * `Op` is the engine's `@atlas/core` change op. We fold create/update ops in via
   * `addGraph` (last-write-wins) and apply deletes via the store's removers; a
   * `resync_required` frame triggers a full reload since the change feed is stale.
   */
  private onFrame(frame: WsFrame): void {
    if (frame.type === 'resync_required') {
      void this.load().then(() => this.canvas().resyncLayout());
      return;
    }
    if (frame.type !== 'batch') return; // 'ready' / 'error' carry no graph changes
    for (const op of frame.ops as Op[]) this.applyOp(op);
    this.canvas().resyncLayout();
  }

  private applyOp(op: Op): void {
    switch (op.op) {
      case 'createNode':
        this.store.addGraph({
          nodes: [{ id: String(op.id), labels: op.labels, props: op.props }],
          edges: [],
        });
        break;
      case 'createEdge':
        this.store.addGraph({
          nodes: [],
          edges: [
            {
              id: String(op.id),
              from: String(op.from),
              to: String(op.to),
              type: op.type,
              props: op.props,
            },
          ],
        });
        break;
      case 'deleteNode':
        this.store.removeNode(String(op.id));
        break;
      // setNodeProps/setEdgeProps/deleteEdge/index ops carry no node-shaped payload
      // (setNodeProps omits labels, so folding it as a node add would clobber them).
      // Property/edge-delete updates land in a later milestone; the create→add and
      // node delete→remove contract above is preserved.
      default:
        break;
    }
  }
}
