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
