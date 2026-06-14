import { describe, expect, it } from 'vitest';
import { neighborQuery, parseGraphRows } from './expand';
import { DEFAULT_EXPAND_CAP } from './graph-model';
import type { QueryResponse } from '@atlas/protocol';

describe('neighborQuery', () => {
  it('builds a parameterized AQL string with cap + skip params', () => {
    const { query, params } = neighborQuery('42', 50, 100);
    expect(query).toContain('MATCH');
    expect(query).toContain('$id');
    expect(query).toContain('LIMIT');
    expect(query).toContain('SKIP');
    expect(params).toEqual({ id: '42', limit: 50, skip: 100 });
  });

  it('defaults the cap to DEFAULT_EXPAND_CAP and skip to 0', () => {
    const { params } = neighborQuery('7');
    expect(params).toEqual({ id: '7', limit: DEFAULT_EXPAND_CAP, skip: 0 });
  });
});

describe('parseGraphRows', () => {
  it('parses node + edge columns into GraphData (deduping by id)', () => {
    // Columns: n (source node), r (edge), m (neighbor node) — the shape neighborQuery returns.
    const res: QueryResponse = {
      columns: ['n', 'r', 'm'],
      rows: [
        [
          { id: '1', labels: ['Person'], properties: { name: 'Ada' } },
          { id: 'e1', type: 'KNOWS', from: '1', to: '2', properties: {} },
          { id: '2', labels: ['Person'], properties: { name: 'Bob' } },
        ],
        [
          { id: '1', labels: ['Person'], properties: { name: 'Ada' } },
          { id: 'e2', type: 'KNOWS', from: '1', to: '3', properties: {} },
          { id: '3', labels: ['Person'], properties: { name: 'Cy' } },
        ],
      ],
      stats: { rowsExamined: 2, elapsedMs: 1 },
    };
    const data = parseGraphRows(res);
    expect(data.nodes.map((n) => n.id).sort()).toEqual(['1', '2', '3']);
    expect(data.edges.map((e) => e.id).sort()).toEqual(['e1', 'e2']);
    expect(data.nodes.find((n) => n.id === '2')?.props['name']).toBe('Bob');
    expect(data.edges[0]).toMatchObject({ from: '1', to: '2', type: 'KNOWS' });
  });

  it('tolerates rows with null/absent edge or neighbor cells', () => {
    const res: QueryResponse = {
      columns: ['n', 'r', 'm'],
      rows: [[{ id: '1', labels: ['Person'], properties: {} }, null, null]],
      stats: { rowsExamined: 1, elapsedMs: 0 },
    };
    const data = parseGraphRows(res);
    expect(data.nodes.map((n) => n.id)).toEqual(['1']);
    expect(data.edges).toEqual([]);
  });

  it('ignores non-graph scalar rows without throwing', () => {
    const res: QueryResponse = { columns: ['c'], rows: [[5]], stats: { rowsExamined: 1, elapsedMs: 0 } };
    expect(parseGraphRows(res)).toEqual({ nodes: [], edges: [] });
  });
});
