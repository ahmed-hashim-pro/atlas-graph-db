import { describe, expect, it } from 'vitest';
import { planToTree, type PlanTreeRow } from './explain-plan';

function labels(rows: PlanTreeRow[]): Array<[number, string]> {
  return rows.map((r) => [r.depth, r.op]);
}

describe('planToTree', () => {
  it('flattens a unary chain (child) into depth-ordered rows', () => {
    const plan = {
      op: 'Project',
      columns: ['name'],
      child: {
        op: 'Filter',
        expr: "p.born > 1800",
        child: { op: 'LabelScan', variable: 'p', label: 'Person', estCost: 3 },
      },
    };
    const rows = planToTree(plan);
    expect(labels(rows)).toEqual([
      [0, 'Project'],
      [1, 'Filter'],
      [2, 'LabelScan'],
    ]);
    expect(rows[0]!.detail).toContain('name');
    expect(rows[2]!.detail).toContain('Person');
    expect(rows[2]!.estCost).toBe(3);
  });

  it('expands binary nodes (left/right) as two children', () => {
    const plan = {
      op: 'CartesianProduct',
      left: { op: 'AllNodesScan', variable: 'a', estCost: 10 },
      right: { op: 'AllNodesScan', variable: 'b', estCost: 10 },
    };
    expect(labels(planToTree(plan))).toEqual([
      [0, 'CartesianProduct'],
      [1, 'AllNodesScan'],
      [1, 'AllNodesScan'],
    ]);
  });

  it('handles a flat write plan ({ op: Write, steps: [...] })', () => {
    const plan = { op: 'Write', steps: [{ op: 'Create', patterns: 1 }, { op: 'Project', columns: 1 }] };
    expect(labels(planToTree(plan))).toEqual([
      [0, 'Write'],
      [1, 'Create'],
      [1, 'Project'],
    ]);
  });

  it('handles a Call plan', () => {
    const plan = { op: 'Call', name: 'algo.pagerank', yields: ['node', 'score'] };
    const rows = planToTree(plan);
    expect(rows[0]!.op).toBe('Call');
    expect(rows[0]!.detail).toContain('algo.pagerank');
  });

  it('never throws on an unknown shape', () => {
    expect(() => planToTree({ op: 'Mystery', foo: 1 })).not.toThrow();
  });
});
