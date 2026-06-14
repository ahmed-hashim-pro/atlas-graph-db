import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { GraphStore } from './graph.store';
import { GraphStoreWorkspaceAdapter } from './graph-store.adapter';

function make(): { adapter: GraphStoreWorkspaceAdapter; store: GraphStore } {
  TestBed.configureTestingModule({ providers: [GraphStore, GraphStoreWorkspaceAdapter] });
  return {
    adapter: TestBed.inject(GraphStoreWorkspaceAdapter),
    store: TestBed.inject(GraphStore),
  };
}

describe('GraphStoreWorkspaceAdapter', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('setGraph projects a numeric-id result payload onto the GraphStore as string-id GraphData', () => {
    const { adapter, store } = make();
    adapter.setGraph({
      nodes: [
        { id: 1, labels: ['Person'], props: { name: 'Ada' } },
        { id: 2, labels: ['Person'], props: { name: 'Bob' } },
      ],
      edges: [{ id: 9, type: 'KNOWS', from: 1, to: 2, props: {} }],
    });

    expect(store.visibleNodes().map((n) => n.id)).toEqual(['1', '2']);
    expect(store.visibleEdges().map((e) => [e.id, e.from, e.to, e.type])).toEqual([
      ['9', '1', '2', 'KNOWS'],
    ]);
  });

  it('setGraph replaces (does not accumulate) the previously displayed graph', () => {
    const { adapter, store } = make();
    adapter.setGraph({ nodes: [{ id: 1, labels: ['Person'], props: {} }], edges: [] });
    adapter.setGraph({ nodes: [{ id: 7, labels: ['Doc'], props: {} }], edges: [] });
    expect(store.visibleNodes().map((n) => n.id)).toEqual(['7']);
  });

  it('paintAlgorithmResult applies score/community/path overrides to the GraphStore nodes', () => {
    const { adapter, store } = make();
    adapter.setGraph({
      nodes: [
        { id: 1, labels: ['Person'], props: {} },
        { id: 2, labels: ['Person'], props: {} },
      ],
      edges: [{ id: 9, type: 'KNOWS', from: 1, to: 2, props: {} }],
    });
    adapter.paintAlgorithmResult({
      scores: new Map([
        [1, 0.3],
        [2, 0.9],
      ]),
      communities: new Map(),
      paths: [[1, 2]],
    });
    const byId = new Map(store.visibleNodes().map((n) => [n.id, n]));
    expect(byId.get('2')!.size!).toBeGreaterThan(byId.get('1')!.size!);
    expect(byId.get('1')!.highlighted).toBe(true);
    expect(byId.get('2')!.highlighted).toBe(true);
  });
});
