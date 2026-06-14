import { describe, expect, it } from 'vitest';
import {
  resultToGraph,
  InMemoryWorkspaceGraphStore,
  type WorkspaceGraphStore,
} from './workspace-graph-store.contract';

describe('resultToGraph', () => {
  it('projects node + edge cells from a result into a graph payload', () => {
    const columns = ['p', 'r', 'q'];
    const rows = [
      [
        { id: 1, labels: ['Person'], props: { name: 'Ada' } },
        { id: 9, type: 'KNOWS', from: 1, to: 2, props: {} },
        { id: 2, labels: ['Person'], props: { name: 'Bob' } },
      ],
    ];
    const g = resultToGraph(columns, rows);
    expect(g.nodes.map((n) => n.id).sort()).toEqual([1, 2]);
    expect(g.edges).toEqual([{ id: 9, type: 'KNOWS', from: 1, to: 2, props: {} }]);
  });

  it('returns empty arrays for a scalar-only result', () => {
    expect(resultToGraph(['name'], [['Ada']])).toEqual({ nodes: [], edges: [] });
  });
});

describe('InMemoryWorkspaceGraphStore (the test fake implementing the contract)', () => {
  it('setGraph replaces the displayed graph; paintAlgorithmResult records the styling', () => {
    const store: WorkspaceGraphStore = new InMemoryWorkspaceGraphStore();
    store.setGraph({ nodes: [{ id: 1, labels: ['Person'], props: {} }], edges: [] });
    const mem = store as InMemoryWorkspaceGraphStore;
    expect(mem.nodes.map((n) => n.id)).toEqual([1]);

    store.paintAlgorithmResult({ scores: new Map([[1, 0.5]]), communities: new Map([[1, 0]]), paths: [] });
    expect(mem.lastPaint?.scores.get(1)).toBe(0.5);
  });
});
