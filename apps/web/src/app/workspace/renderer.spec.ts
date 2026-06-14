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
