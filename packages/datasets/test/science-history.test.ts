import { describe, expect, it } from 'vitest';
import { loadDataset, type TxLike } from '../src/load.js';
import { scienceHistory } from '../src/science-history.js';

describe('scienceHistory', () => {
  it('is deterministic and hits the spec size (~500 nodes)', () => {
    const a = scienceHistory();
    const b = scienceHistory();
    expect(a).toEqual(b);
    expect(a.nodes).toHaveLength(500);
    expect(a.edges.length).toBeGreaterThan(900);
  });

  it('has valid endpoints and the expected label/edge vocabulary', () => {
    const g = scienceHistory();
    const labels = new Set(g.nodes.flatMap((n) => n.labels));
    expect(labels).toEqual(new Set(['Person', 'Concept', 'Document', 'Place']));
    const types = new Set(g.edges.map((e) => e.type));
    expect(types).toEqual(new Set(['WROTE', 'KNOWS', 'CITES', 'INFLUENCED', 'BORN_IN']));
    for (const e of g.edges) {
      expect(e.from).toBeGreaterThanOrEqual(0);
      expect(e.from).toBeLessThan(g.nodes.length);
      expect(e.to).toBeGreaterThanOrEqual(0);
      expect(e.to).toBeLessThan(g.nodes.length);
    }
  });

  it('contains the curated anchors', () => {
    const g = scienceHistory();
    const names = g.nodes.map((n) => n.props.name ?? n.props.title);
    expect(names).toContain('Ada Lovelace');
    expect(names).toContain('Notes on the Analytical Engine');
    expect(names).toContain('On the Origin of Species');
  });

  it('every WROTE edge goes Person -> Document', () => {
    const g = scienceHistory();
    for (const e of g.edges.filter((e) => e.type === 'WROTE')) {
      expect(g.nodes[e.from]!.labels).toContain('Person');
      expect(g.nodes[e.to]!.labels).toContain('Document');
    }
  });
});

describe('loadDataset', () => {
  it('replays nodes then edges through the tx interface in insertion order', async () => {
    const g = scienceHistory();
    const calls: string[] = [];
    let nextId = 1;
    const fakeTx: TxLike = {
      createNode: () => {
        calls.push('node');
        return nextId++;
      },
      createEdge: () => {
        calls.push('edge');
        return nextId++;
      },
    };
    const ids = await loadDataset({ transact: async (fn) => void fn(fakeTx) }, g);
    expect(ids).toHaveLength(g.nodes.length);
    expect(calls.filter((c) => c === 'node')).toHaveLength(g.nodes.length);
    expect(calls.filter((c) => c === 'edge')).toHaveLength(g.edges.length);
    expect(calls.indexOf('edge')).toBeGreaterThan(g.nodes.length - 1); // all nodes first
  });
});
