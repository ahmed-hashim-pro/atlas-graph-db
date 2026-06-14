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
