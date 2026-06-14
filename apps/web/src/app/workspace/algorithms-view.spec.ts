import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { AlgorithmsView } from './algorithms-view';
import { GraphStore } from './graph.store';
import { GraphStoreWorkspaceAdapter } from './graph-store.adapter';
import { findAlgorithm } from './algorithms';
import { WORKSPACE_GRAPH_STORE } from './workspace-graph-store.contract';

const route = {
  snapshot: { paramMap: { get: (k: string) => (k === 'name' ? 'kb' : null) } },
} as unknown as ActivatedRoute;

describe('AlgorithmsView', () => {
  beforeEach(() => TestBed.resetTestingModule());

  // Finding 1: with the workspace's real wiring (WORKSPACE_GRAPH_STORE → the
  // canvas-backed GraphStoreWorkspaceAdapter over a real GraphStore), running an
  // algorithm must paint the REAL GraphStore (size/color/highlight overrides),
  // not a dead in-memory fake.
  it('run() paints the real GraphStore via the workspace adapter', async () => {
    const degree = findAlgorithm('algo.degree')!;
    const query = vi.fn().mockResolvedValue({
      columns: degree.yields,
      rows: [
        [1, 1],
        [2, 3],
      ],
      stats: { rowsExamined: 2, elapsedMs: 1 },
    });
    const database = vi.fn().mockReturnValue({ query });
    TestBed.configureTestingModule({
      providers: [
        AlgorithmsView,
        GraphStore,
        { provide: AtlasApi, useValue: { database } },
        { provide: ActivatedRoute, useValue: route },
        { provide: WORKSPACE_GRAPH_STORE, useClass: GraphStoreWorkspaceAdapter },
      ],
    });
    const view = TestBed.inject(AlgorithmsView);
    const graphStore = TestBed.inject(GraphStore);
    // Seed the canvas with the two nodes the algorithm scores.
    graphStore.replaceGraph({
      nodes: [
        { id: '1', labels: ['Person'], props: {} },
        { id: '2', labels: ['Person'], props: {} },
      ],
      edges: [],
    });
    const paintSpy = vi.spyOn(graphStore, 'applyAlgorithmPaint');

    view.select(degree);
    await view.run();

    expect(paintSpy).toHaveBeenCalledTimes(1);
    expect(view.painted()).toBeGreaterThan(0);
    // The higher-degree node ends up larger on the real store.
    const byId = new Map(graphStore.visibleNodes().map((n) => [n.id, n]));
    expect(byId.get('2')!.size!).toBeGreaterThan(byId.get('1')!.size!);
  });
});
