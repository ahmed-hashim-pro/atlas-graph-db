import { describe, expect, it } from 'vitest';
import { ALGORITHMS, buildAlgorithmCall, paintFromRows, findAlgorithm } from './algorithms';

describe('ALGORITHMS catalog', () => {
  it('covers the §4.7/§5.2 v1 set', () => {
    const names = ALGORITHMS.map((a) => a.name);
    for (const n of [
      'algo.pagerank',
      'algo.louvain',
      'algo.components',
      'algo.degree',
      'algo.betweenness',
      'algo.shortestPath',
      'algo.allShortestPaths',
      'algo.bfs',
      'algo.dfs',
      'algo.topoSort',
      'algo.cycles',
    ])
      expect(names).toContain(n);
  });

  it('declares params with defaults matching the spec table', () => {
    const pr = findAlgorithm('algo.pagerank')!;
    expect(pr.params.find((p) => p.key === 'damping')?.default).toBe(0.85);
    expect(pr.params.find((p) => p.key === 'iterations')?.default).toBe(20);
    expect(pr.yields).toEqual(['node', 'score']);
  });
});

describe('buildAlgorithmCall', () => {
  it('builds a parameterized CALL with YIELD, omitting blank optional params', () => {
    const built = buildAlgorithmCall(findAlgorithm('algo.pagerank')!, {
      damping: 0.85,
      iterations: 20,
    });
    expect(built.query).toBe(
      'CALL algo.pagerank({damping: $damping, iterations: $iterations}) YIELD node, score',
    );
    expect(built.params).toEqual({ damping: 0.85, iterations: 20 });
  });

  it('omits unset optional params and keeps required ones', () => {
    const built = buildAlgorithmCall(findAlgorithm('algo.shortestPath')!, {
      from: 1,
      to: 2,
      weightProp: '',
    });
    expect(built.query).toContain('from: $from');
    expect(built.query).toContain('to: $to');
    expect(built.query).not.toContain('weightProp');
    expect(built.params).toEqual({ from: 1, to: 2 });
  });
});

describe('paintFromRows', () => {
  it('maps score rows to node sizes', () => {
    const paint = paintFromRows(
      findAlgorithm('algo.pagerank')!,
      ['node', 'score'],
      [
        [1, 0.4],
        [2, 0.9],
      ],
    );
    expect(paint.scores.get(1)).toBe(0.4);
    expect(paint.scores.get(2)).toBe(0.9);
    expect(paint.communities.size).toBe(0);
    expect(paint.paths).toEqual([]);
  });

  it('maps community rows to node colors', () => {
    const paint = paintFromRows(
      findAlgorithm('algo.louvain')!,
      ['node', 'community'],
      [
        [1, 0],
        [2, 1],
      ],
    );
    expect(paint.communities.get(1)).toBe(0);
    expect(paint.communities.get(2)).toBe(1);
  });

  it('maps a path result to highlighted node sequences', () => {
    const paint = paintFromRows(
      findAlgorithm('algo.shortestPath')!,
      ['path', 'cost'],
      [[{ nodes: [1, 2, 3], edges: [10, 11] }, 2]],
    );
    expect(paint.paths).toEqual([[1, 2, 3]]);
  });
});
