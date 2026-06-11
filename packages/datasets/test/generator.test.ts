import { describe, expect, it } from 'vitest';
import { generateGraph } from '../src/generator.js';
import { mulberry32 } from '../src/random.js';

describe('mulberry32', () => {
  it('is deterministic and in [0, 1)', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe('generateGraph', () => {
  it('produces exact counts with valid endpoint indices', () => {
    const g = generateGraph({ nodes: 500, edges: 2000, seed: 42 });
    expect(g.nodes).toHaveLength(500);
    expect(g.edges).toHaveLength(2000);
    for (const e of g.edges) {
      expect(e.from).toBeGreaterThanOrEqual(0);
      expect(e.from).toBeLessThan(500);
      expect(e.to).toBeGreaterThanOrEqual(0);
      expect(e.to).toBeLessThan(500);
    }
  });

  it('same seed → identical graph; different seed → different graph', () => {
    const a = generateGraph({ nodes: 50, edges: 100, seed: 1 });
    const b = generateGraph({ nodes: 50, edges: 100, seed: 1 });
    const c = generateGraph({ nodes: 50, edges: 100, seed: 2 });
    expect(a).toEqual(b);
    expect(JSON.stringify(a.edges)).not.toBe(JSON.stringify(c.edges));
  });

  it('skews out-degree (hub formation): top decile owns a disproportionate share', () => {
    const g = generateGraph({ nodes: 1000, edges: 10_000, seed: 42 });
    const outDeg = new Array<number>(1000).fill(0);
    for (const e of g.edges) outDeg[e.from]!++;
    const sorted = [...outDeg].sort((x, y) => y - x);
    const topDecile = sorted.slice(0, 100).reduce((s, d) => s + d, 0);
    expect(topDecile / 10_000).toBeGreaterThan(0.2);
  });

  it('cycles labels and edge types', () => {
    const g = generateGraph({
      nodes: 4,
      edges: 4,
      seed: 1,
      labels: ['A', 'B'],
      edgeTypes: ['X', 'Y'],
    });
    expect(g.nodes.map((n) => n.labels[0])).toEqual(['A', 'B', 'A', 'B']);
    expect(new Set(g.edges.map((e) => e.type))).toEqual(new Set(['X', 'Y']));
  });
});
