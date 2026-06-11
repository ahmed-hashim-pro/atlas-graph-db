import { describe, expect, it } from 'vitest';
import { decodeSnapshot, encodeSnapshot } from '../src/snapshot.js';
import { GraphStore } from '../src/store.js';

describe('snapshot codec', () => {
  it('round-trips store contents plus counters', () => {
    const s = new GraphStore();
    s.applyOp({ op: 'createNode', id: 1, labels: ['A'], props: { name: 'x', when: new Date(5) } });
    s.applyOp({ op: 'createNode', id: 4, labels: ['B'], props: {} });
    s.applyOp({ op: 'createEdge', id: 2, type: 'T', from: 1, to: 4, props: { w: 1 } });

    const buf = encodeSnapshot(s, 9, { nodeNext: 5, edgeNext: 3 });
    const snap = decodeSnapshot(buf);
    expect(snap.lastTxId).toBe(9);
    expect(snap.nextNodeId).toBe(5);
    expect(snap.nextEdgeId).toBe(3);
    expect(snap.nodes).toHaveLength(2);
    expect(snap.edges).toHaveLength(1);
    expect(snap.nodes.find((n) => n.id === 1)?.props.when).toBeInstanceOf(Date);
  });

  it('rejects buffers without the magic header', () => {
    expect(() => decodeSnapshot(Buffer.from('garbage-not-a-snapshot'))).toThrow(/magic/);
  });
});
