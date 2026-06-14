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
    expect(store.edgeTypes().map((t) => [t.type, t.count, t.visible])).toEqual([
      ['KNOWS', 1, true],
    ]);
  });

  it('refreshLegendFromData MERGES with the schema legend: schema-only entries survive a partial load', () => {
    const store = make();
    // Full schema first: Person(2), Doc(1) labels; KNOWS(1) edge type.
    store.ingestSchema(schema);
    // Hide Doc to prove the visibility toggle is preserved across the merge.
    store.toggleLabel('Doc');
    // Load only a subset of Person nodes and no Doc nodes / no KNOWS edges.
    store.addGraph({ nodes: [node('1'), node('2')], edges: [] });

    const labels = store.labels();
    const byLabel = new Map(labels.map((l) => [l.label, l]));
    // Schema-only label (Doc) is NOT dropped despite zero loaded data...
    expect(byLabel.has('Doc')).toBe(true);
    // ...and falls back to its schema total (1) with its visibility preserved (toggled off).
    expect(byLabel.get('Doc')).toMatchObject({ count: 1, visible: false });
    // The loaded label's count reflects the live data (2 loaded), not the schema total.
    expect(byLabel.get('Person')?.count).toBe(2);
    // Stable order: schema order is preserved (Person before Doc).
    expect(labels.map((l) => l.label)).toEqual(['Person', 'Doc']);

    // The schema-only edge type (KNOWS) survives with its schema total even with no edges loaded.
    const knows = store.edgeTypes().find((t) => t.type === 'KNOWS');
    expect(knows).toMatchObject({ type: 'KNOWS', count: 1, visible: true });
  });

  it('addGraph appends labels/types discovered in data that the schema did not list', () => {
    const store = make();
    store.ingestSchema(schema); // Person, Doc / KNOWS
    store.addGraph({
      nodes: [node('1'), node('9', 'Robot')],
      edges: [edge('e', '1', '9', 'BUILT')],
    });
    expect(store.labels().map((l) => l.label)).toEqual(['Person', 'Doc', 'Robot']);
    expect(store.labels().find((l) => l.label === 'Robot')?.count).toBe(1);
    expect(store.edgeTypes().map((t) => t.type)).toEqual(['KNOWS', 'BUILT']);
    expect(store.edgeTypes().find((t) => t.type === 'BUILT')?.count).toBe(1);
  });

  it('addGraph merges nodes/edges and recomputes visible scene + counts', () => {
    const store = make();
    store.addGraph({
      nodes: [node('1'), node('2'), node('3', 'Doc')],
      edges: [edge('e', '1', '2')],
    });
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
    store.addGraph({
      nodes: [node('1'), node('2'), node('3')],
      edges: [edge('e1', '1', '2'), edge('e2', '3', '1')],
    });
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
