import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphCanvas } from './graph-canvas';
import { GraphStore } from './graph.store';
import { worldToScreen } from './viewport';

describe('GraphCanvas component', () => {
  beforeEach(() => TestBed.resetTestingModule());

  function setup() {
    TestBed.configureTestingModule({ imports: [GraphCanvas], providers: [GraphStore] });
    const fixture = TestBed.createComponent(GraphCanvas);
    const store = TestBed.inject(GraphStore);
    return { fixture, cmp: fixture.componentInstance, store };
  }

  /** Force a measurable host box (jsdom reports 0 for layout boxes by default). */
  function stubHostSize(host: HTMLElement, width: number, height: number): void {
    Object.defineProperty(host, 'clientWidth', { value: width, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: height, configurable: true });
  }

  it('creates and renders a canvas element', () => {
    const { fixture } = setup();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('canvas')).toBeTruthy();
  });

  it('sizes the canvas backing store from the host box × devicePixelRatio', () => {
    const { fixture } = setup();
    const host = fixture.nativeElement as HTMLElement;
    stubHostSize(host, 500, 400);
    const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;
    fixture.detectChanges(); // triggers ngAfterViewInit → resizeCanvas()
    const canvas = host.querySelector('canvas')!;
    expect(canvas.width).toBe(Math.round(500 * dpr));
    expect(canvas.height).toBe(Math.round(400 * dpr));
    // CSS size is host-relative (100%), independent of the backing-store pixels.
    expect(canvas.style.width).toBe('100%');
    expect(canvas.style.height).toBe('100%');
  });

  it('a pointer-down at a node’s projected screen coordinate selects that node', () => {
    const { fixture, cmp, store } = setup();
    const host = fixture.nativeElement as HTMLElement;
    stubHostSize(host, 600, 400);
    // A node placed away from the origin so the test exercises the real projection.
    store.addGraph({
      nodes: [{ id: 'n1', labels: ['Person'], props: {}, x: 120, y: -40 }],
      edges: [],
    });
    fixture.detectChanges();
    // Project the node's world position through the live viewport to a screen point,
    // then drive a pointer-up there — hit-test + viewport must agree and select it.
    const screen = worldToScreen({ x: 120, y: -40 }, cmp.viewport());
    cmp.onPointerUp({ offsetX: screen.x, offsetY: screen.y, button: 0 } as PointerEvent);
    expect(store.selection()).toEqual({ kind: 'node', id: 'n1' });
  });

  it('click on a node selects it via the store (hit-test wired)', () => {
    const { fixture, cmp, store } = setup();
    store.addGraph({ nodes: [{ id: 'a', labels: ['Person'], props: {}, x: 0, y: 0 }], edges: [] });
    fixture.detectChanges();
    // World (0,0) at identity-ish transform → screen near origin; click there.
    cmp.onPointerUp({ offsetX: 0, offsetY: 0, button: 0 } as PointerEvent);
    expect(store.selection()).toEqual({ kind: 'node', id: 'a' });
  });

  it('keyboard (Enter / Arrow) selects and cycles through the visible nodes', () => {
    const { fixture, cmp, store } = setup();
    store.addGraph({
      nodes: [
        { id: 'a', labels: ['Person'], props: {}, x: 0, y: 0 },
        { id: 'b', labels: ['Person'], props: {}, x: 10, y: 0 },
      ],
      edges: [],
    });
    fixture.detectChanges();
    cmp.onKeyDown({ key: 'Enter', preventDefault: vi.fn() } as unknown as KeyboardEvent);
    expect(store.selection()).toEqual({ kind: 'node', id: 'a' });
    cmp.onKeyDown({ key: 'ArrowRight', preventDefault: vi.fn() } as unknown as KeyboardEvent);
    expect(store.selection()).toEqual({ kind: 'node', id: 'b' });
    cmp.onKeyDown({ key: 'ArrowRight', preventDefault: vi.fn() } as unknown as KeyboardEvent);
    expect(store.selection()).toEqual({ kind: 'node', id: 'a' }); // wraps around
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
    cmp.onWheel({
      offsetX: 100,
      offsetY: 100,
      deltaY: -100,
      preventDefault: vi.fn(),
    } as unknown as WheelEvent);
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
    cmp.onContextMenu({
      offsetX: 0,
      offsetY: 0,
      clientX: 12,
      clientY: 34,
      preventDefault: vi.fn(),
    } as unknown as MouseEvent);
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
