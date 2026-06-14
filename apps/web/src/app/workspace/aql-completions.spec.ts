import { describe, expect, it } from 'vitest';
import { computeCompletions, makeAqlCompletionSource } from './aql-completions';
import type { SchemaSummary } from '@atlas/core';

const schema: SchemaSummary = {
  labels: [
    {
      label: 'Person',
      count: 3,
      properties: [
        { property: 'name', types: { string: 3 } },
        { property: 'born', types: { number: 3 } },
      ],
    },
    { label: 'Concept', count: 2, properties: [{ property: 'title', types: { string: 2 } }] },
  ],
  edgeTypes: [
    { type: 'WROTE', count: 4, from: { Person: 4 }, to: { Concept: 4 } },
    { type: 'KNOWS', count: 1, from: { Person: 1 }, to: { Person: 1 } },
  ],
};

function labels(text: string): string[] {
  return computeCompletions(schema, text, text.length).map((c) => c.label);
}

describe('computeCompletions', () => {
  it('after a colon, offers labels prefixed with :', () => {
    const got = labels('MATCH (p:');
    expect(got).toContain(':Person');
    expect(got).toContain(':Concept');
  });

  it('after a [: offers edge types', () => {
    expect(labels('MATCH (p)-[:')).toEqual(expect.arrayContaining([':WROTE', ':KNOWS']));
  });

  it('after identifier-dot offers property names', () => {
    const got = labels('MATCH (p:Person) WHERE p.');
    expect(got).toContain('name');
    expect(got).toContain('born');
  });

  it('after CALL offers algo.* procedures', () => {
    const got = labels('CALL algo.');
    expect(got).toEqual(
      expect.arrayContaining(['algo.pagerank', 'algo.louvain', 'algo.shortestPath']),
    );
  });

  it('at a bare word boundary offers keywords (and filters by prefix)', () => {
    expect(labels('MAT')).toContain('MATCH');
    expect(labels('RET')).toContain('RETURN');
    expect(labels('RET')).not.toContain('MATCH');
  });

  it('makeAqlCompletionSource returns a CodeMirror CompletionSource shape', () => {
    const src = makeAqlCompletionSource(() => schema);
    expect(typeof src).toBe('function');
  });
});
