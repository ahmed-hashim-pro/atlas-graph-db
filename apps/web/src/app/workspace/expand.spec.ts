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
    // Cells use the REAL Database.query wire shape: raw NodeRecord/EdgeRecord carry `props`
    // (not `properties`) and numeric ids, which exercises the String(raw.id) coercion too.
    const res: QueryResponse = {
      columns: ['n', 'r', 'm'],
      rows: [
        [
          { id: 1, labels: ['Person'], props: { name: 'Ada' } },
          { id: 'e1', type: 'KNOWS', from: 1, to: 2, props: {} },
          { id: 2, labels: ['Person'], props: { name: 'Bob' } },
        ],
        [
          { id: 1, labels: ['Person'], props: { name: 'Ada' } },
          { id: 'e2', type: 'KNOWS', from: 1, to: 3, props: {} },
          { id: 3, labels: ['Person'], props: { name: 'Cy' } },
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

  it('tolerates rows with null or absent edge/neighbor cells', () => {
    const res: QueryResponse = {
      columns: ['n', 'r', 'm'],
      rows: [
        // explicit null edge + neighbor cells
        [{ id: 1, labels: ['Person'], props: {} }, null, null],
        // genuinely absent trailing cells (short row array)
        [{ id: 4, labels: ['Person'], props: {} }],
      ],
      stats: { rowsExamined: 2, elapsedMs: 0 },
    };
    const data = parseGraphRows(res);
    expect(data.nodes.map((n) => n.id).sort()).toEqual(['1', '4']);
    expect(data.edges).toEqual([]);
  });

  it('ignores non-graph scalar rows without throwing', () => {
    const res: QueryResponse = { columns: ['c'], rows: [[5]], stats: { rowsExamined: 1, elapsedMs: 0 } };
    expect(parseGraphRows(res)).toEqual({ nodes: [], edges: [] });
  });
});
