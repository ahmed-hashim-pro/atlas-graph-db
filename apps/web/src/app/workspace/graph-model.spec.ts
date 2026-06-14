import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RENDER_CAP,
  applyVisibility,
  capNodes,
  mergeGraph,
  type GraphEdge,
  type GraphNode,
} from './graph-model';

function node(id: string, label = 'Person'): GraphNode {
  return { id, labels: [label], props: { name: id } };
}
function edge(id: string, from: string, to: string, type = 'KNOWS'): GraphEdge {
  return { id, from, to, type, props: {} };
}

describe('mergeGraph', () => {
  it('unions nodes and edges by id, last-write-wins on props', () => {
    const a = { nodes: [node('1')], edges: [] as GraphEdge[] };
    const b = { nodes: [{ ...node('1'), props: { name: 'X' } }, node('2')], edges: [edge('e1', '1', '2')] };
    const merged = mergeGraph(a, b);
    expect(merged.nodes.map((n) => n.id).sort()).toEqual(['1', '2']);
    expect(merged.nodes.find((n) => n.id === '1')?.props['name']).toBe('X');
    expect(merged.edges.map((e) => e.id)).toEqual(['e1']);
  });

  it('drops edges whose endpoints are not (yet) present', () => {
    const merged = mergeGraph({ nodes: [node('1')], edges: [] }, { nodes: [], edges: [edge('e', '1', '999')] });
    expect(merged.edges).toEqual([]);
  });
});

describe('capNodes', () => {
  it('keeps the first N nodes and reports the total', () => {
    const nodes = Array.from({ length: 5 }, (_, i) => node(String(i)));
    const { visible, shown, total } = capNodes(nodes, 3);
    expect(shown).toBe(3);
    expect(total).toBe(5);
    expect(visible.map((n) => n.id)).toEqual(['0', '1', '2']);
  });

  it('defaults to DEFAULT_RENDER_CAP and is a no-op under the cap', () => {
    expect(DEFAULT_RENDER_CAP).toBe(300);
    const nodes = [node('a'), node('b')];
    expect(capNodes(nodes, DEFAULT_RENDER_CAP).shown).toBe(2);
  });
});

describe('applyVisibility', () => {
  it('hides nodes of toggled-off labels and edges of toggled-off types', () => {
    const nodes = [node('1', 'Person'), node('2', 'Doc')];
    const edges = [edge('e', '1', '2', 'WROTE')];
    const out = applyVisibility(
      { nodes, edges },
      { hiddenLabels: new Set(['Doc']), hiddenTypes: new Set() },
    );
    expect(out.nodes.map((n) => n.id)).toEqual(['1']);
    expect(out.edges).toEqual([]); // edge endpoint '2' hidden → edge dropped
  });

  it('hides edges of a toggled-off type but keeps the nodes', () => {
    const nodes = [node('1'), node('2')];
    const edges = [edge('e', '1', '2', 'KNOWS')];
    const out = applyVisibility({ nodes, edges }, { hiddenLabels: new Set(), hiddenTypes: new Set(['KNOWS']) });
    expect(out.nodes).toHaveLength(2);
    expect(out.edges).toEqual([]);
  });
});
