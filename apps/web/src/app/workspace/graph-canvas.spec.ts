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
