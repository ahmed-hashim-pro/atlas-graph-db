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
import { fitToNodes, IDENTITY, panBy, screenToWorld, zoomAt, type Point } from './viewport';
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
    const style =
      typeof getComputedStyle === 'function' ? getComputedStyle(this.host.nativeElement) : null;
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
    return hitTest(
      { x: ev.offsetX, y: ev.offsetY },
      this.store.visibleNodes(),
      this.viewport(),
      NODE_RADIUS + 2,
    );
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
    this.viewport.set(fitToNodes(this.store.visibleNodes(), canvas.width, canvas.height, 40));
  }
}
