import { describe, expect, it } from 'vitest';
import { decodeBatch, encodeBatch } from '../src/codec.js';
import type { CommittedBatch } from '../src/types.js';

describe('batch codec', () => {
  it('round-trips a batch including Date properties', () => {
    const batch: CommittedBatch = {
      txId: 7,
      ops: [
        { op: 'createNode', id: 1, labels: ['Person'], props: { name: 'Ada', when: new Date(123456789) } },
        { op: 'createEdge', id: 1, type: 'KNOWS', from: 1, to: 1, props: { tags: ['x'] } },
        { op: 'setNodeProps', id: 1, set: { born: 1815 }, remove: ['name'] },
        { op: 'deleteEdge', id: 1 },
        { op: 'deleteNode', id: 1 },
      ],
    };
    const decoded = decodeBatch(encodeBatch(batch));
    expect(decoded).toEqual(batch);
    expect((decoded.ops[0] as { props: { when: unknown } }).props.when).toBeInstanceOf(Date);
  });
});
