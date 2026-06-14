import { describe, expect, it } from 'vitest';
import { searchQuery, toHits, type NodeHit } from './node-search';
import type { QueryResponse } from '@atlas/protocol';

describe('searchQuery', () => {
  it('builds a parameterized AQL query that CONTAINS the term on name/title', () => {
    const { query, params } = searchQuery('Ada', 25);
    expect(query).toContain('MATCH (n)');
    expect(query).toContain('CONTAINS');
    expect(query).toContain('$term');
    expect(query).toContain('n.name');
    expect(query).toContain('n.title');
    expect(query).toContain('LIMIT $limit');
    // The term is bound verbatim as a parameter — never interpolated into the query.
    expect(params.term).toBe('Ada');
    expect(params.limit).toBe(25);
  });

  it('trims surrounding whitespace from the bound term', () => {
    expect(searchQuery('  Ada  ', 10).params.term).toBe('Ada');
  });
});

describe('toHits', () => {
  const res: QueryResponse = {
    columns: ['n'],
    rows: [
      [{ id: '7', labels: ['Person'], props: { name: 'Ada Lovelace' } }],
      [{ id: '8', labels: ['City'], props: { title: 'Bath' } }],
    ],
    stats: { rowsExamined: 2, elapsedMs: 0 },
  };

  it('maps node cells to hits with a display label derived from props', () => {
    const hits: NodeHit[] = toHits(res);
    expect(hits[0]).toEqual({ id: '7', labels: ['Person'], label: 'Ada Lovelace' });
    // Falls back to the next common name-ish prop, then to the id.
    expect(hits[1].label).toBe('Bath');
  });

  it('falls back to "#id" when no name-ish property exists', () => {
    const noName: QueryResponse = {
      columns: ['n'],
      rows: [[{ id: '9', labels: ['X'], props: { weight: 3 } }]],
      stats: { rowsExamined: 1, elapsedMs: 0 },
    };
    expect(toHits(noName)[0].label).toBe('#9');
  });

  it('ignores non-node cells', () => {
    const mixed: QueryResponse = {
      columns: ['x'],
      rows: [[42], ['str'], [null]],
      stats: { rowsExamined: 0, elapsedMs: 0 },
    };
    expect(toHits(mixed)).toEqual([]);
  });
});
