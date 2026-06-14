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

/** Frames to let the seeded d3-force layout settle before auto-fitting the camera. */
const AUTO_FIT_FRAMES = 60;

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
  private resizeObserver: ResizeObserver | null = null;
  /** Logical (CSS-pixel) size of the canvas; kept in sync with the host element. */
  private cssWidth = 0;
  private cssHeight = 0;
  /** Backing-store scale factor; world/screen math stays in CSS px and the context absorbs dpr. */
  private dpr = 1;
  /**
   * Frames to wait after a (re)sync before auto-fitting, so the d3-force layout has warmed
   * up and nodes have positions to frame. -1 means "no pending auto-fit". The user's own
   * pan/zoom cancels a pending fit so we never yank the camera out from under them.
   */
  private autoFitCountdown = -1;

  /** Test seam: overridden in specs to capture worker messages without a real Worker. */
  testWorkerPost: ((msg: LayoutInbound) => void) | null = null;

  ngAfterViewInit(): void {
    this.refreshTheme();
    this.resizeCanvas();
    this.observeResize();
    this.spawnWorker();
    this.loop();
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.postToWorker({ type: 'stop' });
    this.worker?.terminate();
  }

  /**
   * Size the canvas backing store to the host's CSS box × devicePixelRatio and set the
   * CSS size to the measured box. World↔screen math operates in CSS pixels and pointer
   * events report CSS pixels (offsetX/offsetY), so hit-testing and rendering share one
   * coordinate space; the 2D context absorbs `dpr` via `setTransform` each frame.
   */
  private resizeCanvas(): void {
    const canvas = this.canvasRef().nativeElement;
    const host = this.host.nativeElement;
    const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;
    // Prefer the host's measured box; fall back to the canvas's own client box.
    const w = host.clientWidth || canvas.clientWidth || this.cssWidth;
    const h = host.clientHeight || canvas.clientHeight || this.cssHeight;
    if (w <= 0 || h <= 0) return;
    this.cssWidth = w;
    this.cssHeight = h;
    this.dpr = dpr;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = '100%';
    canvas.style.height = '100%';
  }

  private observeResize(): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
    this.resizeObserver.observe(this.host.nativeElement);
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
    // Frame the freshly-seeded layout once it has warmed up (positions stream in
    // over the next frames). Only schedule when there is something to frame.
    if (nodes.length > 0) this.autoFitCountdown = AUTO_FIT_FRAMES;
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
    if (this.autoFitCountdown >= 0 && --this.autoFitCountdown < 0) this.fit();
    this.render();
    this.raf = requestAnimationFrame(this.loop);
  };

  render(): void {
    const canvas = this.canvasRef().nativeElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Absorb the device-pixel-ratio in the context so all draw calls (and the
    // background clear) work in CSS pixels — the same space pointer events use.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    drawGraph(ctx, {
      nodes: this.store.visibleNodes(),
      edges: this.store.visibleEdges(),
      viewport: this.viewport(),
      theme: this.theme,
      selection: this.store.selection(),
      colorOf: this.colorOf,
      width: this.cssWidth || canvas.width,
      height: this.cssHeight || canvas.height,
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
      this.autoFitCountdown = -1; // user is steering; do not yank the camera
      const world = screenToWorld({ x: ev.offsetX, y: ev.offsetY }, this.viewport());
      this.store.applyPositions(new Map([[this.dragId, world]]));
    } else if (this.panning) {
      this.autoFitCountdown = -1;
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
    this.autoFitCountdown = -1; // user is steering; do not yank the camera
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

  /**
   * Keyboard selection for the canvas (§7.5 a11y): Enter/Space/ArrowRight selects the next
   * visible node, ArrowLeft the previous, cycling. This is a deterministic, real selection
   * path that does not depend on pixel-precise pointer hits, mirroring the canvas for keyboard
   * users and giving the e2e a stable way to drive a real selection.
   */
  onKeyDown(ev: KeyboardEvent): void {
    const keys = ['Enter', ' ', 'Spacebar', 'ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'];
    if (!keys.includes(ev.key)) return;
    const nodes = this.store.visibleNodes();
    if (nodes.length === 0) return;
    ev.preventDefault();
    const sel = this.store.selection();
    const current = sel?.kind === 'node' ? nodes.findIndex((n) => n.id === sel.id) : -1;
    const back = ev.key === 'ArrowLeft' || ev.key === 'ArrowUp';
    const next = current < 0 ? 0 : (current + (back ? -1 : 1) + nodes.length) % nodes.length;
    this.store.select({ kind: 'node', id: nodes[next].id });
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

  /**
   * Re-fit the camera to the current nodes, framing them into the live canvas CSS box
   * (not the dpr-scaled backing store, and not a hard-coded size). No-op when nothing
   * has a position yet so the next fit (after the layout warms up) still frames the graph.
   */
  fit(): void {
    const canvas = this.canvasRef().nativeElement;
    const w = this.cssWidth || canvas.clientWidth || canvas.width;
    const h = this.cssHeight || canvas.clientHeight || canvas.height;
    this.viewport.set(fitToNodes(this.store.visibleNodes(), w, h, 40));
  }
}
