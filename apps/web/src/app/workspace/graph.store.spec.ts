import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { GraphStore } from './graph.store';
import type { GraphEdge, GraphNode } from './graph-model';
import type { SchemaSummary } from '@atlas/core';

function node(id: string, label = 'Person'): GraphNode {
  return { id, labels: [label], props: { name: id } };
}
function edge(id: string, from: string, to: string, type = 'KNOWS'): GraphEdge {
  return { id, from, to, type, props: {} };
}
const schema: SchemaSummary = {
  labels: [
    { label: 'Person', count: 2, properties: [] },
    { label: 'Doc', count: 1, properties: [] },
  ],
  edgeTypes: [{ type: 'KNOWS', count: 1, from: { Person: 1 }, to: { Person: 1 } }],
};

function make(): GraphStore {
  return TestBed.runInInjectionContext(() => new GraphStore());
}

describe('GraphStore', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('ingests schema into label/edge legend entries with counts, all visible by default', () => {
    const store = make();
    store.ingestSchema(schema);
    expect(store.labels().map((l) => [l.label, l.count, l.visible])).toEqual([
      ['Person', 2, true],
      ['Doc', 1, true],
    ]);
    expect(store.edgeTypes()).toEqual([{ type: 'KNOWS', count: 1, visible: true }]);
  });

  it('addGraph merges nodes/edges and recomputes visible scene + counts', () => {
    const store = make();
    store.addGraph({ nodes: [node('1'), node('2'), node('3', 'Doc')], edges: [edge('e', '1', '2')] });
    expect(store.totalNodeCount()).toBe(3);
    expect(store.visibleNodes()).toHaveLength(3);
    expect(store.visibleEdges()).toHaveLength(1);
  });

  it('toggling a label hides its nodes (and dependent edges) from the visible scene', () => {
    const store = make();
    store.addGraph({ nodes: [node('1'), node('2', 'Doc')], edges: [edge('e', '1', '2', 'WROTE')] });
    store.toggleLabel('Doc');
    expect(store.visibleNodes().map((n) => n.id)).toEqual(['1']);
    expect(store.visibleEdges()).toEqual([]);
  });

  it('toggling an edge type hides only those edges', () => {
    const store = make();
    store.addGraph({ nodes: [node('1'), node('2')], edges: [edge('e', '1', '2', 'KNOWS')] });
    store.toggleEdgeType('KNOWS');
    expect(store.visibleNodes()).toHaveLength(2);
    expect(store.visibleEdges()).toEqual([]);
  });

  it('enforces the render cap and reports "showing N of M"', () => {
    const store = make();
    store.setRenderCap(2);
    store.addGraph({ nodes: [node('1'), node('2'), node('3')], edges: [] });
    expect(store.visibleNodes()).toHaveLength(2);
    expect(store.shownCount()).toBe(2);
    expect(store.totalNodeCount()).toBe(3);
    expect(store.isCapped()).toBe(true);
  });

  it('selection: select a node, then a node-not-present clears selection', () => {
    const store = make();
    store.addGraph({ nodes: [node('1')], edges: [] });
    store.select({ kind: 'node', id: '1' });
    expect(store.selection()).toEqual({ kind: 'node', id: '1' });
    expect(store.selectedNode()?.id).toBe('1');
    store.select(null);
    expect(store.selection()).toBeNull();
    expect(store.selectedNode()).toBeNull();
  });

  it('connectionsOf returns incident edges with the neighbor id', () => {
    const store = make();
    store.addGraph({ nodes: [node('1'), node('2'), node('3')], edges: [edge('e1', '1', '2'), edge('e2', '3', '1')] });
    const conns = store.connectionsOf('1');
    expect(conns.map((c) => c.neighborId).sort()).toEqual(['2', '3']);
    expect(conns.find((c) => c.neighborId === '2')?.direction).toBe('out');
    expect(conns.find((c) => c.neighborId === '3')?.direction).toBe('in');
  });

  it('removeNode (live delete) drops the node, its edges, and clears selection if it was selected', () => {
    const store = make();
    store.addGraph({ nodes: [node('1'), node('2')], edges: [edge('e', '1', '2')] });
    store.select({ kind: 'node', id: '1' });
    store.removeNode('1');
    expect(store.visibleNodes().map((n) => n.id)).toEqual(['2']);
    expect(store.visibleEdges()).toEqual([]);
    expect(store.selection()).toBeNull();
  });
});
