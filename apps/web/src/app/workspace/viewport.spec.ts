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
