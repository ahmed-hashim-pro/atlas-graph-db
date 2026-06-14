import { describe, expect, it } from 'vitest';
import { formatCell, isNodeCell, isEdgeCell, extractGraphElements } from './cell-format';

describe('cell detection', () => {
  it('detects a node cell ({ id, labels, props })', () => {
    expect(isNodeCell({ id: 1, labels: ['Person'], props: { name: 'Ada' } })).toBe(true);
    expect(isNodeCell({ id: 1, type: 'KNOWS', from: 1, to: 2, props: {} })).toBe(false);
    expect(isNodeCell('Ada')).toBe(false);
    expect(isNodeCell(42)).toBe(false);
  });

  it('detects an edge cell ({ id, type, from, to, props })', () => {
    expect(isEdgeCell({ id: 5, type: 'KNOWS', from: 1, to: 2, props: {} })).toBe(true);
    expect(isEdgeCell({ id: 1, labels: ['Person'], props: {} })).toBe(false);
  });
});

describe('formatCell', () => {
  it('renders primitives, nulls, and arrays', () => {
    expect(formatCell('Ada')).toBe('Ada');
    expect(formatCell(1815)).toBe('1815');
    expect(formatCell(null)).toBe('∅');
    expect(formatCell(true)).toBe('true');
    expect(formatCell([1, 2, 3])).toBe('[1, 2, 3]');
  });

  it('renders a node as :Label {name…} and an edge as -[:TYPE]->', () => {
    expect(formatCell({ id: 1, labels: ['Person'], props: { name: 'Ada' } })).toBe(':Person {name: Ada}');
    expect(formatCell({ id: 5, type: 'KNOWS', from: 1, to: 2, props: {} })).toBe('-[:KNOWS]->');
  });
});

describe('extractGraphElements', () => {
  it('collects nodes and edges from a result, de-duplicating by id', () => {
    const columns = ['p', 'r', 'q'];
    const rows = [
      [
        { id: 1, labels: ['Person'], props: { name: 'Ada' } },
        { id: 5, type: 'KNOWS', from: 1, to: 2, props: {} },
        { id: 2, labels: ['Person'], props: { name: 'Bob' } },
      ],
      [{ id: 1, labels: ['Person'], props: { name: 'Ada' } }, null, { id: 2, labels: ['Person'], props: {} }],
    ];
    const g = extractGraphElements(columns, rows);
    expect(g.nodes.map((n) => n.id).sort()).toEqual([1, 2]);
    expect(g.edges.map((e) => e.id)).toEqual([5]);
    expect(g.hasGraph).toBe(true);
  });

  it('reports hasGraph=false for a scalar-only result', () => {
    expect(extractGraphElements(['name'], [['Ada'], ['Bob']]).hasGraph).toBe(false);
  });
});
