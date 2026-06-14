import { describe, expect, it } from 'vitest';
import { buildSchemaDiagram } from './schema-diagram';
import type { SchemaSummary } from '@atlas/core';

const schema: SchemaSummary = {
  labels: [
    { label: 'Person', count: 3, properties: [{ property: 'name', types: { string: 3 } }] },
    { label: 'Concept', count: 2, properties: [] },
  ],
  edgeTypes: [
    { type: 'WROTE', count: 4, from: { Person: 4 }, to: { Concept: 4 } },
    { type: 'KNOWS', count: 1, from: { Person: 1 }, to: { Person: 1 } },
  ],
};

describe('buildSchemaDiagram', () => {
  it('produces one node per label with its count, positioned within the viewport', () => {
    const d = buildSchemaDiagram(schema, { width: 800, height: 600 });
    expect(d.nodes.map((n) => n.label).sort()).toEqual(['Concept', 'Person']);
    const person = d.nodes.find((n) => n.label === 'Person')!;
    expect(person.count).toBe(3);
    expect(person.x).toBeGreaterThanOrEqual(0);
    expect(person.x).toBeLessThanOrEqual(800);
    expect(person.y).toBeGreaterThanOrEqual(0);
    expect(person.y).toBeLessThanOrEqual(600);
  });

  it('resolves each edge type to its dominant from/to label endpoints', () => {
    const d = buildSchemaDiagram(schema, { width: 800, height: 600 });
    const wrote = d.edges.find((e) => e.type === 'WROTE')!;
    expect(wrote.fromLabel).toBe('Person');
    expect(wrote.toLabel).toBe('Concept');
    expect(wrote.count).toBe(4);
    expect(wrote.fromX).toEqual(d.nodes.find((n) => n.label === 'Person')!.x);
  });

  it('marks a self-referential edge type (from === to)', () => {
    const d = buildSchemaDiagram(schema, { width: 800, height: 600 });
    expect(d.edges.find((e) => e.type === 'KNOWS')!.selfLoop).toBe(true);
  });

  it('handles an empty schema without throwing', () => {
    expect(buildSchemaDiagram({ labels: [], edgeTypes: [] }, { width: 100, height: 100 })).toEqual({
      nodes: [],
      edges: [],
    });
  });

  it('drops an edge whose endpoints are not present as labels', () => {
    const orphan: SchemaSummary = {
      labels: [{ label: 'Person', count: 1, properties: [] }],
      edgeTypes: [{ type: 'GHOST', count: 1, from: { Ghost: 1 }, to: { Person: 1 } }],
    };
    expect(buildSchemaDiagram(orphan, { width: 100, height: 100 }).edges).toEqual([]);
  });
});
